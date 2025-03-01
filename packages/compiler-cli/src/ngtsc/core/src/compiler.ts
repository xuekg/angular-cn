/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import ts from 'typescript';

import {ComponentDecoratorHandler, DirectiveDecoratorHandler, InjectableDecoratorHandler, NgModuleDecoratorHandler, NoopReferencesRegistry, PipeDecoratorHandler, ReferencesRegistry} from '../../annotations';
import {InjectableClassRegistry} from '../../annotations/common';
import {CycleAnalyzer, CycleHandlingStrategy, ImportGraph} from '../../cycles';
import {COMPILER_ERRORS_WITH_GUIDES, ERROR_DETAILS_PAGE_BASE_URL, ErrorCode, ngErrorCode} from '../../diagnostics';
import {checkForPrivateExports, ReferenceGraph} from '../../entry_point';
import {absoluteFromSourceFile, AbsoluteFsPath, LogicalFileSystem, resolve} from '../../file_system';
import {AbsoluteModuleStrategy, AliasingHost, AliasStrategy, DefaultImportTracker, ImportRewriter, LocalIdentifierStrategy, LogicalProjectStrategy, ModuleResolver, NoopImportRewriter, PrivateExportAliasingHost, R3SymbolsImportRewriter, Reference, ReferenceEmitStrategy, ReferenceEmitter, RelativePathStrategy, UnifiedModulesAliasingHost, UnifiedModulesStrategy} from '../../imports';
import {IncrementalBuildStrategy, IncrementalCompilation, IncrementalState} from '../../incremental';
import {SemanticSymbol} from '../../incremental/semantic_graph';
import {generateAnalysis, IndexedComponent, IndexingContext} from '../../indexer';
import {ComponentResources, CompoundMetadataReader, CompoundMetadataRegistry, DirectiveMeta, DtsMetadataReader, HostDirectivesResolver, LocalMetadataRegistry, MetadataReader, MetadataReaderWithIndex, PipeMeta, ResourceRegistry} from '../../metadata';
import {PartialEvaluator} from '../../partial_evaluator';
import {ActivePerfRecorder, DelegatingPerfRecorder, PerfCheckpoint, PerfEvent, PerfPhase} from '../../perf';
import {FileUpdate, ProgramDriver, UpdateMode} from '../../program_driver';
import {DeclarationNode, isNamedClassDeclaration, TypeScriptReflectionHost} from '../../reflection';
import {AdapterResourceLoader} from '../../resource';
import {ComponentScopeReader, CompoundComponentScopeReader, LocalModuleScopeRegistry, MetadataDtsModuleScopeResolver, TypeCheckScopeRegistry} from '../../scope';
import {StandaloneComponentScopeReader} from '../../scope/src/standalone';
import {generatedFactoryTransform} from '../../shims';
import {aliasTransformFactory, CompilationMode, declarationTransformFactory, DecoratorHandler, DtsTransformRegistry, ivyTransformFactory, TraitCompiler} from '../../transform';
import {getModifiers} from '../../ts_compatibility';
import {TemplateTypeCheckerImpl} from '../../typecheck';
import {OptimizeFor, TemplateTypeChecker, TypeCheckingConfig} from '../../typecheck/api';
import {ALL_DIAGNOSTIC_FACTORIES, ExtendedTemplateCheckerImpl} from '../../typecheck/extended';
import {ExtendedTemplateChecker} from '../../typecheck/extended/api';
import {getSourceFileOrNull, isDtsPath, toUnredirectedSourceFile} from '../../util/src/typescript';
import {Xi18nContext} from '../../xi18n';
import {DiagnosticCategoryLabel, NgCompilerAdapter, NgCompilerOptions} from '../api';

/**
 * State information about a compilation which is only generated once some data is requested from
 * the `NgCompiler` (for example, by calling `getDiagnostics`).
 *
 * 有关编译的状态信息，仅在从 `NgCompiler` 请求某些数据时才会生成（例如，通过调用 `getDiagnostics`
 *）。
 *
 */
interface LazyCompilationState {
  isCore: boolean;
  traitCompiler: TraitCompiler;
  reflector: TypeScriptReflectionHost;
  metaReader: MetadataReader;
  scopeRegistry: LocalModuleScopeRegistry;
  typeCheckScopeRegistry: TypeCheckScopeRegistry;
  exportReferenceGraph: ReferenceGraph|null;
  dtsTransforms: DtsTransformRegistry;
  aliasingHost: AliasingHost|null;
  refEmitter: ReferenceEmitter;
  templateTypeChecker: TemplateTypeChecker;
  resourceRegistry: ResourceRegistry;
  extendedTemplateChecker: ExtendedTemplateChecker|null;
}



/**
 * Discriminant type for a `CompilationTicket`.
 *
 * `CompilationTicket` 的判别类型。
 *
 */
export enum CompilationTicketKind {
  Fresh,
  IncrementalTypeScript,
  IncrementalResource,
}

/**
 * Begin an Angular compilation operation from scratch.
 *
 * 从头开始 Angular 编译操作。
 *
 */
export interface FreshCompilationTicket {
  kind: CompilationTicketKind.Fresh;
  options: NgCompilerOptions;
  incrementalBuildStrategy: IncrementalBuildStrategy;
  programDriver: ProgramDriver;
  enableTemplateTypeChecker: boolean;
  usePoisonedData: boolean;
  tsProgram: ts.Program;
  perfRecorder: ActivePerfRecorder;
}

/**
 * Begin an Angular compilation operation that incorporates changes to TypeScript code.
 *
 * 开始一个包含对 TypeScript 代码更改的 Angular 编译操作。
 *
 */
export interface IncrementalTypeScriptCompilationTicket {
  kind: CompilationTicketKind.IncrementalTypeScript;
  options: NgCompilerOptions;
  newProgram: ts.Program;
  incrementalBuildStrategy: IncrementalBuildStrategy;
  incrementalCompilation: IncrementalCompilation;
  programDriver: ProgramDriver;
  enableTemplateTypeChecker: boolean;
  usePoisonedData: boolean;
  perfRecorder: ActivePerfRecorder;
}

export interface IncrementalResourceCompilationTicket {
  kind: CompilationTicketKind.IncrementalResource;
  compiler: NgCompiler;
  modifiedResourceFiles: Set<string>;
  perfRecorder: ActivePerfRecorder;
}

/**
 * A request to begin Angular compilation, either starting from scratch or from a known prior state.
 *
 * 开始 Angular 编译的请求，可以从头开始或从已知的先前状态开始。
 *
 * `CompilationTicket`s are used to initialize (or update) an `NgCompiler` instance, the core of the
 * Angular compiler. They abstract the starting state of compilation and allow `NgCompiler` to be
 * managed independently of any incremental compilation lifecycle.
 *
 * `CompilationTicket` 用于初始化（或更新）`NgCompiler` 实例，这是 Angular
 * 编译器的核心。它们抽象了编译的启动状态，并允许 `NgCompiler` 独立于任何增量编译生命周期进行管理。
 *
 */
export type CompilationTicket = FreshCompilationTicket|IncrementalTypeScriptCompilationTicket|
    IncrementalResourceCompilationTicket;

/**
 * Create a `CompilationTicket` for a brand new compilation, using no prior state.
 *
 * 为全新的编译创建一个 `CompilationTicket` ，不使用先前的状态。
 *
 */
export function freshCompilationTicket(
    tsProgram: ts.Program, options: NgCompilerOptions,
    incrementalBuildStrategy: IncrementalBuildStrategy, programDriver: ProgramDriver,
    perfRecorder: ActivePerfRecorder|null, enableTemplateTypeChecker: boolean,
    usePoisonedData: boolean): CompilationTicket {
  return {
    kind: CompilationTicketKind.Fresh,
    tsProgram,
    options,
    incrementalBuildStrategy,
    programDriver,
    enableTemplateTypeChecker,
    usePoisonedData,
    perfRecorder: perfRecorder ?? ActivePerfRecorder.zeroedToNow(),
  };
}

/**
 * Create a `CompilationTicket` as efficiently as possible, based on a previous `NgCompiler`
 * instance and a new `ts.Program`.
 *
 * 根据以前的 `NgCompiler` 实例和新的 `ts.Program` ，尽可能高效地创建一个 `CompilationTicket` 。
 *
 */
export function incrementalFromCompilerTicket(
    oldCompiler: NgCompiler, newProgram: ts.Program,
    incrementalBuildStrategy: IncrementalBuildStrategy, programDriver: ProgramDriver,
    modifiedResourceFiles: Set<AbsoluteFsPath>,
    perfRecorder: ActivePerfRecorder|null): CompilationTicket {
  const oldProgram = oldCompiler.getCurrentProgram();
  const oldState = oldCompiler.incrementalStrategy.getIncrementalState(oldProgram);
  if (oldState === null) {
    // No incremental step is possible here, since no IncrementalDriver was found for the old
    // program.
    return freshCompilationTicket(
        newProgram, oldCompiler.options, incrementalBuildStrategy, programDriver, perfRecorder,
        oldCompiler.enableTemplateTypeChecker, oldCompiler.usePoisonedData);
  }

  if (perfRecorder === null) {
    perfRecorder = ActivePerfRecorder.zeroedToNow();
  }

  const incrementalCompilation = IncrementalCompilation.incremental(
      newProgram, versionMapFromProgram(newProgram, programDriver), oldProgram, oldState,
      modifiedResourceFiles, perfRecorder);

  return {
    kind: CompilationTicketKind.IncrementalTypeScript,
    enableTemplateTypeChecker: oldCompiler.enableTemplateTypeChecker,
    usePoisonedData: oldCompiler.usePoisonedData,
    options: oldCompiler.options,
    incrementalBuildStrategy,
    incrementalCompilation,
    programDriver,
    newProgram,
    perfRecorder,
  };
}

/**
 * Create a `CompilationTicket` directly from an old `ts.Program` and associated Angular compilation
 * state, along with a new `ts.Program`.
 *
 * 直接从旧的 `ts.Program` 和关联的 Angular 编译状态以及新的 `ts.Program` `CompilationTicket`
 *
 */
export function incrementalFromStateTicket(
    oldProgram: ts.Program, oldState: IncrementalState, newProgram: ts.Program,
    options: NgCompilerOptions, incrementalBuildStrategy: IncrementalBuildStrategy,
    programDriver: ProgramDriver, modifiedResourceFiles: Set<AbsoluteFsPath>,
    perfRecorder: ActivePerfRecorder|null, enableTemplateTypeChecker: boolean,
    usePoisonedData: boolean): CompilationTicket {
  if (perfRecorder === null) {
    perfRecorder = ActivePerfRecorder.zeroedToNow();
  }
  const incrementalCompilation = IncrementalCompilation.incremental(
      newProgram, versionMapFromProgram(newProgram, programDriver), oldProgram, oldState,
      modifiedResourceFiles, perfRecorder);
  return {
    kind: CompilationTicketKind.IncrementalTypeScript,
    newProgram,
    options,
    incrementalBuildStrategy,
    incrementalCompilation,
    programDriver,
    enableTemplateTypeChecker,
    usePoisonedData,
    perfRecorder,
  };
}

export function resourceChangeTicket(compiler: NgCompiler, modifiedResourceFiles: Set<string>):
    IncrementalResourceCompilationTicket {
  return {
    kind: CompilationTicketKind.IncrementalResource,
    compiler,
    modifiedResourceFiles,
    perfRecorder: ActivePerfRecorder.zeroedToNow(),
  };
}


/**
 * The heart of the Angular Ivy compiler.
 *
 * Angular Ivy 编译器的核心。
 *
 * The `NgCompiler` provides an API for performing Angular compilation within a custom TypeScript
 * compiler. Each instance of `NgCompiler` supports a single compilation, which might be
 * incremental.
 *
 * `NgCompiler` 提供了一个 API，用于在自定义 TypeScript 编译器中执行 Angular 编译。 `NgCompiler`
 * 的每个实例都支持单次编译，这可能是增量的。
 *
 * `NgCompiler` is lazy, and does not perform any of the work of the compilation until one of its
 * output methods (e.g. `getDiagnostics`) is called.
 *
 * `NgCompiler` 是延迟的，在调用其输出方法之一（例如 `getDiagnostics`）之前不会执行任何编译工作。
 *
 * See the README.md for more information.
 *
 * 有关更多信息，请参阅 README.md 。
 *
 */
export class NgCompiler {
  /**
   * Lazily evaluated state of the compilation.
   *
   * 延迟估算的编译状态。
   *
   * This is created on demand by calling `ensureAnalyzed`.
   *
   * 这是通过调用 `ensureAnalyzed` 按需创建的。
   *
   */
  private compilation: LazyCompilationState|null = null;

  /**
   * Any diagnostics related to the construction of the compilation.
   *
   * 与编译构建相关的任何诊断。
   *
   * These are diagnostics which arose during setup of the host and/or program.
   *
   * 这些是在设置宿主和/或程序期间出现的诊断。
   *
   */
  private constructionDiagnostics: ts.Diagnostic[] = [];

  /**
   * Non-template diagnostics related to the program itself. Does not include template
   * diagnostics because the template type checker memoizes them itself.
   *
   * 与程序本身相关的非模板诊断。不包括模板诊断，因为模板类型检查器自己会记住它们。
   *
   * This is set by (and memoizes) `getNonTemplateDiagnostics`.
   *
   * 这是由 `getNonTemplateDiagnostics` 设置（并记住）的。
   *
   */
  private nonTemplateDiagnostics: ts.Diagnostic[]|null = null;

  private closureCompilerEnabled: boolean;
  private currentProgram: ts.Program;
  private entryPoint: ts.SourceFile|null;
  private moduleResolver: ModuleResolver;
  private resourceManager: AdapterResourceLoader;
  private cycleAnalyzer: CycleAnalyzer;
  readonly ignoreForDiagnostics: Set<ts.SourceFile>;
  readonly ignoreForEmit: Set<ts.SourceFile>;
  readonly enableTemplateTypeChecker: boolean;

  /**
   * `NgCompiler` can be reused for multiple compilations (for resource-only changes), and each
   * new compilation uses a fresh `PerfRecorder`. Thus, classes created with a lifespan of the
   * `NgCompiler` use a `DelegatingPerfRecorder` so the `PerfRecorder` they write to can be updated
   * with each fresh compilation.
   *
   * `NgCompiler` 可以用于多次编译（用于仅资源更改），并且每个新的编译都使用一个新的 `PerfRecorder`
   * 。因此，使用 `NgCompiler` 的生命周期创建的类会使用 `DelegatingPerfRecorder` ，因此它们写入的
   * `PerfRecorder` 可以在每次新编译时更新。
   *
   */
  private delegatingPerfRecorder = new DelegatingPerfRecorder(this.perfRecorder);

  /**
   * Convert a `CompilationTicket` into an `NgCompiler` instance for the requested compilation.
   *
   * 将 `CompilationTicket` 转换为 `NgCompiler` 实例以进行所请求的编译。
   *
   * Depending on the nature of the compilation request, the `NgCompiler` instance may be reused
   * from a previous compilation and updated with any changes, it may be a new instance which
   * incrementally reuses state from a previous compilation, or it may represent a fresh
   * compilation entirely.
   *
   * 根据编译请求的性质，`NgCompiler`
   * 实例可以从以前的编译中重用并使用任何更改进行更新，它可能是一个新实例，可以增量地重用以前编译中的状态，或者它可能完全代表一个新的编译。
   *
   */
  static fromTicket(ticket: CompilationTicket, adapter: NgCompilerAdapter) {
    switch (ticket.kind) {
      case CompilationTicketKind.Fresh:
        return new NgCompiler(
            adapter,
            ticket.options,
            ticket.tsProgram,
            ticket.programDriver,
            ticket.incrementalBuildStrategy,
            IncrementalCompilation.fresh(
                ticket.tsProgram, versionMapFromProgram(ticket.tsProgram, ticket.programDriver)),
            ticket.enableTemplateTypeChecker,
            ticket.usePoisonedData,
            ticket.perfRecorder,
        );
      case CompilationTicketKind.IncrementalTypeScript:
        return new NgCompiler(
            adapter,
            ticket.options,
            ticket.newProgram,
            ticket.programDriver,
            ticket.incrementalBuildStrategy,
            ticket.incrementalCompilation,
            ticket.enableTemplateTypeChecker,
            ticket.usePoisonedData,
            ticket.perfRecorder,
        );
      case CompilationTicketKind.IncrementalResource:
        const compiler = ticket.compiler;
        compiler.updateWithChangedResources(ticket.modifiedResourceFiles, ticket.perfRecorder);
        return compiler;
    }
  }

  private constructor(
      private adapter: NgCompilerAdapter,
      readonly options: NgCompilerOptions,
      private inputProgram: ts.Program,
      readonly programDriver: ProgramDriver,
      readonly incrementalStrategy: IncrementalBuildStrategy,
      readonly incrementalCompilation: IncrementalCompilation,
      enableTemplateTypeChecker: boolean,
      readonly usePoisonedData: boolean,
      private livePerfRecorder: ActivePerfRecorder,
  ) {
    this.enableTemplateTypeChecker =
        enableTemplateTypeChecker || (options._enableTemplateTypeChecker ?? false);
    this.constructionDiagnostics.push(
        ...this.adapter.constructionDiagnostics, ...verifyCompatibleTypeCheckOptions(this.options));

    this.currentProgram = inputProgram;
    this.closureCompilerEnabled = !!this.options.annotateForClosureCompiler;

    this.entryPoint =
        adapter.entryPoint !== null ? getSourceFileOrNull(inputProgram, adapter.entryPoint) : null;

    const moduleResolutionCache = ts.createModuleResolutionCache(
        this.adapter.getCurrentDirectory(),
        // doen't retain a reference to `this`, if other closures in the constructor here reference
        // `this` internally then a closure created here would retain them. This can cause major
        // memory leak issues since the `moduleResolutionCache` is a long-lived object and finds its
        // way into all kinds of places inside TS internal objects.
        this.adapter.getCanonicalFileName.bind(this.adapter));
    this.moduleResolver =
        new ModuleResolver(inputProgram, this.options, this.adapter, moduleResolutionCache);
    this.resourceManager = new AdapterResourceLoader(adapter, this.options);
    this.cycleAnalyzer = new CycleAnalyzer(
        new ImportGraph(inputProgram.getTypeChecker(), this.delegatingPerfRecorder));
    this.incrementalStrategy.setIncrementalState(this.incrementalCompilation.state, inputProgram);

    this.ignoreForDiagnostics =
        new Set(inputProgram.getSourceFiles().filter(sf => this.adapter.isShim(sf)));
    this.ignoreForEmit = this.adapter.ignoreForEmit;

    let dtsFileCount = 0;
    let nonDtsFileCount = 0;
    for (const sf of inputProgram.getSourceFiles()) {
      if (sf.isDeclarationFile) {
        dtsFileCount++;
      } else {
        nonDtsFileCount++;
      }
    }

    livePerfRecorder.eventCount(PerfEvent.InputDtsFile, dtsFileCount);
    livePerfRecorder.eventCount(PerfEvent.InputTsFile, nonDtsFileCount);
  }

  get perfRecorder(): ActivePerfRecorder {
    return this.livePerfRecorder;
  }

  /**
   * Exposes the `IncrementalCompilation` under an old property name that the CLI uses, avoiding a
   * chicken-and-egg problem with the rename to `incrementalCompilation`.
   *
   * 在 CLI 使用的旧属性名称下公开 `IncrementalCompilation` ，避免重命名为 `incrementalCompilation`
   * 时出现先有鸡还是先有蛋的问题。
   *
   * TODO(alxhub): remove when the CLI uses the new name.
   *
   * TODO(alxhub) ：在 CLI 使用新名称时删除。
   *
   */
  get incrementalDriver(): IncrementalCompilation {
    return this.incrementalCompilation;
  }

  private updateWithChangedResources(
      changedResources: Set<string>, perfRecorder: ActivePerfRecorder): void {
    this.livePerfRecorder = perfRecorder;
    this.delegatingPerfRecorder.target = perfRecorder;

    perfRecorder.inPhase(PerfPhase.ResourceUpdate, () => {
      if (this.compilation === null) {
        // Analysis hasn't happened yet, so no update is necessary - any changes to resources will
        // be captured by the initial analysis pass itself.
        return;
      }

      this.resourceManager.invalidate();

      const classesToUpdate = new Set<DeclarationNode>();
      for (const resourceFile of changedResources) {
        for (const templateClass of this.getComponentsWithTemplateFile(resourceFile)) {
          classesToUpdate.add(templateClass);
        }

        for (const styleClass of this.getComponentsWithStyleFile(resourceFile)) {
          classesToUpdate.add(styleClass);
        }
      }

      for (const clazz of classesToUpdate) {
        this.compilation.traitCompiler.updateResources(clazz);
        if (!ts.isClassDeclaration(clazz)) {
          continue;
        }

        this.compilation.templateTypeChecker.invalidateClass(clazz);
      }
    });
  }

  /**
   * Get the resource dependencies of a file.
   *
   * 获取文件的资源依赖项。
   *
   * If the file is not part of the compilation, an empty array will be returned.
   *
   * 如果文件不是编译的一部分，则将返回一个空数组。
   *
   */
  getResourceDependencies(file: ts.SourceFile): string[] {
    this.ensureAnalyzed();

    return this.incrementalCompilation.depGraph.getResourceDependencies(file);
  }

  /**
   * Get all Angular-related diagnostics for this compilation.
   *
   * 获取此编译的所有与 Angular 相关的诊断。
   *
   */
  getDiagnostics(): ts.Diagnostic[] {
    const diagnostics: ts.Diagnostic[] = [];
    diagnostics.push(...this.getNonTemplateDiagnostics(), ...this.getTemplateDiagnostics());
    if (this.options.strictTemplates) {
      diagnostics.push(...this.getExtendedTemplateDiagnostics());
    }
    return this.addMessageTextDetails(diagnostics);
  }

  /**
   * Get all Angular-related diagnostics for this compilation.
   *
   * 获取此编译的所有与 Angular 相关的诊断。
   *
   * If a `ts.SourceFile` is passed, only diagnostics related to that file are returned.
   *
   * 如果传递了 `ts.SourceFile` ，则仅返回与该文件相关的诊断信息。
   *
   */
  getDiagnosticsForFile(file: ts.SourceFile, optimizeFor: OptimizeFor): ts.Diagnostic[] {
    const diagnostics: ts.Diagnostic[] = [];
    diagnostics.push(
        ...this.getNonTemplateDiagnostics().filter(diag => diag.file === file),
        ...this.getTemplateDiagnosticsForFile(file, optimizeFor));
    if (this.options.strictTemplates) {
      diagnostics.push(...this.getExtendedTemplateDiagnostics(file));
    }
    return this.addMessageTextDetails(diagnostics);
  }

  /**
   * Get all `ts.Diagnostic`s currently available that pertain to the given component.
   *
   * 获取当前可用的与给定组件有关的所有 `ts.Diagnostic` 。
   *
   */
  getDiagnosticsForComponent(component: ts.ClassDeclaration): ts.Diagnostic[] {
    const compilation = this.ensureAnalyzed();
    const ttc = compilation.templateTypeChecker;
    const diagnostics: ts.Diagnostic[] = [];
    diagnostics.push(...ttc.getDiagnosticsForComponent(component));

    const extendedTemplateChecker = compilation.extendedTemplateChecker;
    if (this.options.strictTemplates && extendedTemplateChecker) {
      diagnostics.push(...extendedTemplateChecker.getDiagnosticsForComponent(component));
    }
    return this.addMessageTextDetails(diagnostics);
  }

  /**
   * Add Angular.io error guide links to diagnostics for this compilation.
   *
   * 将 Angular.io 错误指南链接添加到此编译的诊断。
   *
   */
  private addMessageTextDetails(diagnostics: ts.Diagnostic[]): ts.Diagnostic[] {
    return diagnostics.map(diag => {
      if (diag.code && COMPILER_ERRORS_WITH_GUIDES.has(ngErrorCode(diag.code))) {
        return {
          ...diag,
          messageText: diag.messageText +
              `. Find more at ${ERROR_DETAILS_PAGE_BASE_URL}/NG${ngErrorCode(diag.code)}`
        };
      }
      return diag;
    });
  }

  /**
   * Get all setup-related diagnostics for this compilation.
   *
   * 获取此编译的所有与设置相关的诊断。
   *
   */
  getOptionDiagnostics(): ts.Diagnostic[] {
    return this.constructionDiagnostics;
  }

  /**
   * Get the current `ts.Program` known to this `NgCompiler`.
   *
   * 获取此 `ts.Program` 已知的当前 `NgCompiler` 。
   *
   * Compilation begins with an input `ts.Program`, and during template type-checking operations new
   * `ts.Program`s may be produced using the `ProgramDriver`. The most recent such `ts.Program` to
   * be produced is available here.
   *
   * 编译从输入 `ts.Program` 开始，在模板类型检查操作期间，可以用 `ProgramDriver` 生成新的
   * `ts.Program` 。要生成的最新的此类 `ts.Program` 可在此获得。
   *
   * This `ts.Program` serves two key purposes:
   *
   * 此 `ts.Program` 有两个主要目的：
   *
   * * As an incremental starting point for creating the next `ts.Program` based on files that the
   *   user has changed (for clients using the TS compiler program APIs).
   *
   *   作为根据用户更改的文件创建下一个 `ts.Program` 的增量起点（对于使用 TS 编译器程序 API
   * 的客户端）。
   *
   * * As the "before" point for an incremental compilation invocation, to determine what's changed
   *   between the old and new programs (for all compilations).
   *
   *   作为增量编译调用的“之前”点，以确定新旧程序之间发生的变化（对于所有编译）。
   *
   */
  getCurrentProgram(): ts.Program {
    return this.currentProgram;
  }

  getTemplateTypeChecker(): TemplateTypeChecker {
    if (!this.enableTemplateTypeChecker) {
      throw new Error(
          'The `TemplateTypeChecker` does not work without `enableTemplateTypeChecker`.');
    }
    return this.ensureAnalyzed().templateTypeChecker;
  }

  /**
   * Retrieves the `ts.Declaration`s for any component(s) which use the given template file.
   *
   * 检索使用给定模板文件的任何组件的 `ts.Declaration` 。
   *
   */
  getComponentsWithTemplateFile(templateFilePath: string): ReadonlySet<DeclarationNode> {
    const {resourceRegistry} = this.ensureAnalyzed();
    return resourceRegistry.getComponentsWithTemplate(resolve(templateFilePath));
  }

  /**
   * Retrieves the `ts.Declaration`s for any component(s) which use the given template file.
   *
   * 检索使用给定模板文件的任何组件的 `ts.Declaration` 。
   *
   */
  getComponentsWithStyleFile(styleFilePath: string): ReadonlySet<DeclarationNode> {
    const {resourceRegistry} = this.ensureAnalyzed();
    return resourceRegistry.getComponentsWithStyle(resolve(styleFilePath));
  }

  /**
   * Retrieves external resources for the given component.
   *
   * 检索给定组件的外部资源。
   *
   */
  getComponentResources(classDecl: DeclarationNode): ComponentResources|null {
    if (!isNamedClassDeclaration(classDecl)) {
      return null;
    }
    const {resourceRegistry} = this.ensureAnalyzed();
    const styles = resourceRegistry.getStyles(classDecl);
    const template = resourceRegistry.getTemplate(classDecl);
    if (template === null) {
      return null;
    }

    return {styles, template};
  }

  getMeta(classDecl: DeclarationNode): PipeMeta|DirectiveMeta|null {
    if (!isNamedClassDeclaration(classDecl)) {
      return null;
    }
    const ref = new Reference(classDecl);
    const {metaReader} = this.ensureAnalyzed();
    const meta = metaReader.getPipeMetadata(ref) ?? metaReader.getDirectiveMetadata(ref);
    if (meta === null) {
      return null;
    }
    return meta;
  }

  /**
   * Perform Angular's analysis step (as a precursor to `getDiagnostics` or `prepareEmit`)
   * asynchronously.
   *
   * 异步执行 Angular 的分析步骤（作为 `getDiagnostics` 或 `prepareEmit` 的前体）。
   *
   * Normally, this operation happens lazily whenever `getDiagnostics` or `prepareEmit` are called.
   * However, certain consumers may wish to allow for an asynchronous phase of analysis, where
   * resources such as `styleUrls` are resolved asynchronously. In these cases `analyzeAsync` must
   * be called first, and its `Promise` awaited prior to calling any other APIs of `NgCompiler`.
   *
   * 通常，每当 `getDiagnostics` 或 `prepareEmit`
   * 时，此操作都会延迟发生。但是，某些消费者可能希望允许分析的异步阶段，其中的资源（例如
   * `styleUrls`）会被异步解析。在这些情况下，必须首先调用 `analyzeAsync` ，并在调用 `NgCompiler`
   * 的任何其他 API 之前等待其 `Promise` 。
   *
   */
  async analyzeAsync(): Promise<void> {
    if (this.compilation !== null) {
      return;
    }

    await this.perfRecorder.inPhase(PerfPhase.Analysis, async () => {
      this.compilation = this.makeCompilation();

      const promises: Promise<void>[] = [];
      for (const sf of this.inputProgram.getSourceFiles()) {
        if (sf.isDeclarationFile) {
          continue;
        }

        let analysisPromise = this.compilation.traitCompiler.analyzeAsync(sf);
        if (analysisPromise !== undefined) {
          promises.push(analysisPromise);
        }
      }

      await Promise.all(promises);

      this.perfRecorder.memory(PerfCheckpoint.Analysis);
      this.resolveCompilation(this.compilation.traitCompiler);
    });
  }

  /**
   * Fetch transformers and other information which is necessary for a consumer to `emit` the
   * program with Angular-added definitions.
   *
   * 获取消费者使用 Angular 添加的定义 `emit` 程序所需的转换器和其他信息。
   *
   */
  prepareEmit(): {
    transformers: ts.CustomTransformers,
  } {
    const compilation = this.ensureAnalyzed();

    const coreImportsFrom = compilation.isCore ? getR3SymbolsFile(this.inputProgram) : null;
    let importRewriter: ImportRewriter;
    if (coreImportsFrom !== null) {
      importRewriter = new R3SymbolsImportRewriter(coreImportsFrom.fileName);
    } else {
      importRewriter = new NoopImportRewriter();
    }

    const defaultImportTracker = new DefaultImportTracker();

    const before = [
      ivyTransformFactory(
          compilation.traitCompiler, compilation.reflector, importRewriter, defaultImportTracker,
          this.delegatingPerfRecorder, compilation.isCore, this.closureCompilerEnabled),
      aliasTransformFactory(compilation.traitCompiler.exportStatements),
      defaultImportTracker.importPreservingTransformer(),
    ];

    const afterDeclarations: ts.TransformerFactory<ts.SourceFile>[] = [];
    if (compilation.dtsTransforms !== null) {
      afterDeclarations.push(
          declarationTransformFactory(compilation.dtsTransforms, importRewriter));
    }

    // Only add aliasing re-exports to the .d.ts output if the `AliasingHost` requests it.
    if (compilation.aliasingHost !== null && compilation.aliasingHost.aliasExportsInDts) {
      afterDeclarations.push(aliasTransformFactory(compilation.traitCompiler.exportStatements));
    }

    if (this.adapter.factoryTracker !== null) {
      before.push(
          generatedFactoryTransform(this.adapter.factoryTracker.sourceInfo, importRewriter));
    }

    return {transformers: {before, afterDeclarations} as ts.CustomTransformers};
  }

  /**
   * Run the indexing process and return a `Map` of all indexed components.
   *
   * 运行索引过程并返回所有索引组件的 `Map` 。
   *
   * See the `indexing` package for more details.
   *
   * 有关更多详细信息，请参阅 `indexing` 包。
   *
   */
  getIndexedComponents(): Map<DeclarationNode, IndexedComponent> {
    const compilation = this.ensureAnalyzed();
    const context = new IndexingContext();
    compilation.traitCompiler.index(context);
    return generateAnalysis(context);
  }

  /**
   * Collect i18n messages into the `Xi18nContext`.
   *
   * 将 i18n 消息收集到 `Xi18nContext` 中。
   *
   */
  xi18n(ctx: Xi18nContext): void {
    // Note that the 'resolve' phase is not strictly necessary for xi18n, but this is not currently
    // optimized.
    const compilation = this.ensureAnalyzed();
    compilation.traitCompiler.xi18n(ctx);
  }

  private ensureAnalyzed(this: NgCompiler): LazyCompilationState {
    if (this.compilation === null) {
      this.analyzeSync();
    }
    return this.compilation!;
  }

  private analyzeSync(): void {
    this.perfRecorder.inPhase(PerfPhase.Analysis, () => {
      this.compilation = this.makeCompilation();
      for (const sf of this.inputProgram.getSourceFiles()) {
        if (sf.isDeclarationFile) {
          continue;
        }
        this.compilation.traitCompiler.analyzeSync(sf);
      }

      this.perfRecorder.memory(PerfCheckpoint.Analysis);

      this.resolveCompilation(this.compilation.traitCompiler);
    });
  }

  private resolveCompilation(traitCompiler: TraitCompiler): void {
    this.perfRecorder.inPhase(PerfPhase.Resolve, () => {
      traitCompiler.resolve();

      // At this point, analysis is complete and the compiler can now calculate which files need to
      // be emitted, so do that.
      this.incrementalCompilation.recordSuccessfulAnalysis(traitCompiler);

      this.perfRecorder.memory(PerfCheckpoint.Resolve);
    });
  }

  private get fullTemplateTypeCheck(): boolean {
    // Determine the strictness level of type checking based on compiler options. As
    // `strictTemplates` is a superset of `fullTemplateTypeCheck`, the former implies the latter.
    // Also see `verifyCompatibleTypeCheckOptions` where it is verified that `fullTemplateTypeCheck`
    // is not disabled when `strictTemplates` is enabled.
    const strictTemplates = !!this.options.strictTemplates;
    return strictTemplates || !!this.options.fullTemplateTypeCheck;
  }

  private getTypeCheckingConfig(): TypeCheckingConfig {
    // Determine the strictness level of type checking based on compiler options. As
    // `strictTemplates` is a superset of `fullTemplateTypeCheck`, the former implies the latter.
    // Also see `verifyCompatibleTypeCheckOptions` where it is verified that `fullTemplateTypeCheck`
    // is not disabled when `strictTemplates` is enabled.
    const strictTemplates = !!this.options.strictTemplates;

    const useInlineTypeConstructors = this.programDriver.supportsInlineOperations;

    // First select a type-checking configuration, based on whether full template type-checking is
    // requested.
    let typeCheckingConfig: TypeCheckingConfig;
    if (this.fullTemplateTypeCheck) {
      typeCheckingConfig = {
        applyTemplateContextGuards: strictTemplates,
        checkQueries: false,
        checkTemplateBodies: true,
        alwaysCheckSchemaInTemplateBodies: true,
        checkTypeOfInputBindings: strictTemplates,
        honorAccessModifiersForInputBindings: false,
        strictNullInputBindings: strictTemplates,
        checkTypeOfAttributes: strictTemplates,
        // Even in full template type-checking mode, DOM binding checks are not quite ready yet.
        checkTypeOfDomBindings: false,
        checkTypeOfOutputEvents: strictTemplates,
        checkTypeOfAnimationEvents: strictTemplates,
        // Checking of DOM events currently has an adverse effect on developer experience,
        // e.g. for `<input (blur)="update($event.target.value)">` enabling this check results in:
        // - error TS2531: Object is possibly 'null'.
        // - error TS2339: Property 'value' does not exist on type 'EventTarget'.
        checkTypeOfDomEvents: strictTemplates,
        checkTypeOfDomReferences: strictTemplates,
        // Non-DOM references have the correct type in View Engine so there is no strictness flag.
        checkTypeOfNonDomReferences: true,
        // Pipes are checked in View Engine so there is no strictness flag.
        checkTypeOfPipes: true,
        strictSafeNavigationTypes: strictTemplates,
        useContextGenericType: strictTemplates,
        strictLiteralTypes: true,
        enableTemplateTypeChecker: this.enableTemplateTypeChecker,
        useInlineTypeConstructors,
        // Warnings for suboptimal type inference are only enabled if in Language Service mode
        // (providing the full TemplateTypeChecker API) and if strict mode is not enabled. In strict
        // mode, the user is in full control of type inference.
        suggestionsForSuboptimalTypeInference: this.enableTemplateTypeChecker && !strictTemplates,
      };
    } else {
      typeCheckingConfig = {
        applyTemplateContextGuards: false,
        checkQueries: false,
        checkTemplateBodies: false,
        // Enable deep schema checking in "basic" template type-checking mode only if Closure
        // compilation is requested, which is a good proxy for "only in google3".
        alwaysCheckSchemaInTemplateBodies: this.closureCompilerEnabled,
        checkTypeOfInputBindings: false,
        strictNullInputBindings: false,
        honorAccessModifiersForInputBindings: false,
        checkTypeOfAttributes: false,
        checkTypeOfDomBindings: false,
        checkTypeOfOutputEvents: false,
        checkTypeOfAnimationEvents: false,
        checkTypeOfDomEvents: false,
        checkTypeOfDomReferences: false,
        checkTypeOfNonDomReferences: false,
        checkTypeOfPipes: false,
        strictSafeNavigationTypes: false,
        useContextGenericType: false,
        strictLiteralTypes: false,
        enableTemplateTypeChecker: this.enableTemplateTypeChecker,
        useInlineTypeConstructors,
        // In "basic" template type-checking mode, no warnings are produced since most things are
        // not checked anyways.
        suggestionsForSuboptimalTypeInference: false,
      };
    }

    // Apply explicitly configured strictness flags on top of the default configuration
    // based on "fullTemplateTypeCheck".
    if (this.options.strictInputTypes !== undefined) {
      typeCheckingConfig.checkTypeOfInputBindings = this.options.strictInputTypes;
      typeCheckingConfig.applyTemplateContextGuards = this.options.strictInputTypes;
    }
    if (this.options.strictInputAccessModifiers !== undefined) {
      typeCheckingConfig.honorAccessModifiersForInputBindings =
          this.options.strictInputAccessModifiers;
    }
    if (this.options.strictNullInputTypes !== undefined) {
      typeCheckingConfig.strictNullInputBindings = this.options.strictNullInputTypes;
    }
    if (this.options.strictOutputEventTypes !== undefined) {
      typeCheckingConfig.checkTypeOfOutputEvents = this.options.strictOutputEventTypes;
      typeCheckingConfig.checkTypeOfAnimationEvents = this.options.strictOutputEventTypes;
    }
    if (this.options.strictDomEventTypes !== undefined) {
      typeCheckingConfig.checkTypeOfDomEvents = this.options.strictDomEventTypes;
    }
    if (this.options.strictSafeNavigationTypes !== undefined) {
      typeCheckingConfig.strictSafeNavigationTypes = this.options.strictSafeNavigationTypes;
    }
    if (this.options.strictDomLocalRefTypes !== undefined) {
      typeCheckingConfig.checkTypeOfDomReferences = this.options.strictDomLocalRefTypes;
    }
    if (this.options.strictAttributeTypes !== undefined) {
      typeCheckingConfig.checkTypeOfAttributes = this.options.strictAttributeTypes;
    }
    if (this.options.strictContextGenerics !== undefined) {
      typeCheckingConfig.useContextGenericType = this.options.strictContextGenerics;
    }
    if (this.options.strictLiteralTypes !== undefined) {
      typeCheckingConfig.strictLiteralTypes = this.options.strictLiteralTypes;
    }

    return typeCheckingConfig;
  }

  private getTemplateDiagnostics(): ReadonlyArray<ts.Diagnostic> {
    const compilation = this.ensureAnalyzed();

    // Get the diagnostics.
    const diagnostics: ts.Diagnostic[] = [];
    for (const sf of this.inputProgram.getSourceFiles()) {
      if (sf.isDeclarationFile || this.adapter.isShim(sf)) {
        continue;
      }

      diagnostics.push(
          ...compilation.templateTypeChecker.getDiagnosticsForFile(sf, OptimizeFor.WholeProgram));
    }

    const program = this.programDriver.getProgram();
    this.incrementalStrategy.setIncrementalState(this.incrementalCompilation.state, program);
    this.currentProgram = program;

    return diagnostics;
  }

  private getTemplateDiagnosticsForFile(sf: ts.SourceFile, optimizeFor: OptimizeFor):
      ReadonlyArray<ts.Diagnostic> {
    const compilation = this.ensureAnalyzed();

    // Get the diagnostics.
    const diagnostics: ts.Diagnostic[] = [];
    if (!sf.isDeclarationFile && !this.adapter.isShim(sf)) {
      diagnostics.push(...compilation.templateTypeChecker.getDiagnosticsForFile(sf, optimizeFor));
    }

    const program = this.programDriver.getProgram();
    this.incrementalStrategy.setIncrementalState(this.incrementalCompilation.state, program);
    this.currentProgram = program;

    return diagnostics;
  }

  private getNonTemplateDiagnostics(): ts.Diagnostic[] {
    if (this.nonTemplateDiagnostics === null) {
      const compilation = this.ensureAnalyzed();
      this.nonTemplateDiagnostics = [...compilation.traitCompiler.diagnostics];
      if (this.entryPoint !== null && compilation.exportReferenceGraph !== null) {
        this.nonTemplateDiagnostics.push(...checkForPrivateExports(
            this.entryPoint, this.inputProgram.getTypeChecker(), compilation.exportReferenceGraph));
      }
    }
    return this.nonTemplateDiagnostics;
  }

  /**
   * Calls the `extendedTemplateCheck` phase of the trait compiler
   *
   * 调用 trait 编译器的 `extendedTemplateCheck` 阶段
   *
   * @param sf optional parameter to get diagnostics for a certain file
   *     or all files in the program if `sf` is undefined
   *
   * 如果 `sf` 未定义，则用于获取程序中某个文件或所有文件的诊断信息的可选参数
   *
   * @returns
   *
   * generated extended template diagnostics
   *
   * 生成的扩展模板诊断
   *
   */
  private getExtendedTemplateDiagnostics(sf?: ts.SourceFile): ts.Diagnostic[] {
    const diagnostics: ts.Diagnostic[] = [];
    const compilation = this.ensureAnalyzed();
    const extendedTemplateChecker = compilation.extendedTemplateChecker;
    if (!extendedTemplateChecker) {
      return [];
    }

    if (sf !== undefined) {
      return compilation.traitCompiler.extendedTemplateCheck(sf, extendedTemplateChecker);
    }
    for (const sf of this.inputProgram.getSourceFiles()) {
      diagnostics.push(
          ...compilation.traitCompiler.extendedTemplateCheck(sf, extendedTemplateChecker));
    }

    return diagnostics;
  }

  private makeCompilation(): LazyCompilationState {
    const checker = this.inputProgram.getTypeChecker();

    const reflector = new TypeScriptReflectionHost(checker);

    // Construct the ReferenceEmitter.
    let refEmitter: ReferenceEmitter;
    let aliasingHost: AliasingHost|null = null;
    if (this.adapter.unifiedModulesHost === null || !this.options._useHostForImportGeneration) {
      let localImportStrategy: ReferenceEmitStrategy;

      // The strategy used for local, in-project imports depends on whether TS has been configured
      // with rootDirs. If so, then multiple directories may be mapped in the same "module
      // namespace" and the logic of `LogicalProjectStrategy` is required to generate correct
      // imports which may cross these multiple directories. Otherwise, plain relative imports are
      // sufficient.
      if (this.options.rootDir !== undefined ||
          (this.options.rootDirs !== undefined && this.options.rootDirs.length > 0)) {
        // rootDirs logic is in effect - use the `LogicalProjectStrategy` for in-project relative
        // imports.
        localImportStrategy = new LogicalProjectStrategy(
            reflector, new LogicalFileSystem([...this.adapter.rootDirs], this.adapter));
      } else {
        // Plain relative imports are all that's needed.
        localImportStrategy = new RelativePathStrategy(reflector);
      }

      // The CompilerHost doesn't have fileNameToModuleName, so build an NPM-centric reference
      // resolution strategy.
      refEmitter = new ReferenceEmitter([
        // First, try to use local identifiers if available.
        new LocalIdentifierStrategy(),
        // Next, attempt to use an absolute import.
        new AbsoluteModuleStrategy(this.inputProgram, checker, this.moduleResolver, reflector),
        // Finally, check if the reference is being written into a file within the project's .ts
        // sources, and use a relative import if so. If this fails, ReferenceEmitter will throw
        // an error.
        localImportStrategy,
      ]);

      // If an entrypoint is present, then all user imports should be directed through the
      // entrypoint and private exports are not needed. The compiler will validate that all publicly
      // visible directives/pipes are importable via this entrypoint.
      if (this.entryPoint === null && this.options.generateDeepReexports === true) {
        // No entrypoint is present and deep re-exports were requested, so configure the aliasing
        // system to generate them.
        aliasingHost = new PrivateExportAliasingHost(reflector);
      }
    } else {
      // The CompilerHost supports fileNameToModuleName, so use that to emit imports.
      refEmitter = new ReferenceEmitter([
        // First, try to use local identifiers if available.
        new LocalIdentifierStrategy(),
        // Then use aliased references (this is a workaround to StrictDeps checks).
        new AliasStrategy(),
        // Then use fileNameToModuleName to emit imports.
        new UnifiedModulesStrategy(reflector, this.adapter.unifiedModulesHost),
      ]);
      aliasingHost = new UnifiedModulesAliasingHost(this.adapter.unifiedModulesHost);
    }

    const isCore = isAngularCorePackage(this.inputProgram);

    const evaluator =
        new PartialEvaluator(reflector, checker, this.incrementalCompilation.depGraph);
    const dtsReader = new DtsMetadataReader(checker, reflector);
    const localMetaRegistry = new LocalMetadataRegistry();
    const localMetaReader: MetadataReaderWithIndex = localMetaRegistry;
    const depScopeReader = new MetadataDtsModuleScopeResolver(dtsReader, aliasingHost);
    const metaReader = new CompoundMetadataReader([localMetaReader, dtsReader]);
    const ngModuleScopeRegistry = new LocalModuleScopeRegistry(
        localMetaReader, metaReader, depScopeReader, refEmitter, aliasingHost);
    const standaloneScopeReader =
        new StandaloneComponentScopeReader(metaReader, ngModuleScopeRegistry, depScopeReader);
    const scopeReader: ComponentScopeReader =
        new CompoundComponentScopeReader([ngModuleScopeRegistry, standaloneScopeReader]);
    const semanticDepGraphUpdater = this.incrementalCompilation.semanticDepGraphUpdater;
    const metaRegistry = new CompoundMetadataRegistry([localMetaRegistry, ngModuleScopeRegistry]);
    const injectableRegistry = new InjectableClassRegistry(reflector, isCore);
    const hostDirectivesResolver = new HostDirectivesResolver(metaReader);

    const typeCheckScopeRegistry =
        new TypeCheckScopeRegistry(scopeReader, metaReader, hostDirectivesResolver);


    // If a flat module entrypoint was specified, then track references via a `ReferenceGraph` in
    // order to produce proper diagnostics for incorrectly exported directives/pipes/etc. If there
    // is no flat module entrypoint then don't pay the cost of tracking references.
    let referencesRegistry: ReferencesRegistry;
    let exportReferenceGraph: ReferenceGraph|null = null;
    if (this.entryPoint !== null) {
      exportReferenceGraph = new ReferenceGraph();
      referencesRegistry = new ReferenceGraphAdapter(exportReferenceGraph);
    } else {
      referencesRegistry = new NoopReferencesRegistry();
    }

    const dtsTransforms = new DtsTransformRegistry();

    const resourceRegistry = new ResourceRegistry();

    // Note: If this compilation builds `@angular/core`, we always build in full compilation
    // mode. Code inside the core package is always compatible with itself, so it does not
    // make sense to go through the indirection of partial compilation
    const compilationMode = this.options.compilationMode === 'partial' && !isCore ?
        CompilationMode.PARTIAL :
        CompilationMode.FULL;

    // Cycles are handled in full compilation mode by "remote scoping".
    // "Remote scoping" does not work well with tree shaking for libraries.
    // So in partial compilation mode, when building a library, a cycle will cause an error.
    const cycleHandlingStrategy = compilationMode === CompilationMode.FULL ?
        CycleHandlingStrategy.UseRemoteScoping :
        CycleHandlingStrategy.Error;

    const strictCtorDeps = this.options.strictInjectionParameters || false;

    // Set up the IvyCompilation, which manages state for the Ivy transformer.
    const handlers: DecoratorHandler<unknown, unknown, SemanticSymbol|null, unknown>[] = [
      new ComponentDecoratorHandler(
          reflector, evaluator, metaRegistry, metaReader, scopeReader, depScopeReader,
          ngModuleScopeRegistry, typeCheckScopeRegistry, resourceRegistry, isCore, strictCtorDeps,
          this.resourceManager, this.adapter.rootDirs, this.options.preserveWhitespaces || false,
          this.options.i18nUseExternalIds !== false,
          this.options.enableI18nLegacyMessageIdFormat !== false, this.usePoisonedData,
          this.options.i18nNormalizeLineEndingsInICUs === true, this.moduleResolver,
          this.cycleAnalyzer, cycleHandlingStrategy, refEmitter,
          this.incrementalCompilation.depGraph, injectableRegistry, semanticDepGraphUpdater,
          this.closureCompilerEnabled, this.delegatingPerfRecorder, hostDirectivesResolver),

      // TODO(alxhub): understand why the cast here is necessary (something to do with `null`
      // not being assignable to `unknown` when wrapped in `Readonly`).
      // clang-format off
        new DirectiveDecoratorHandler(
            reflector, evaluator, metaRegistry, ngModuleScopeRegistry, metaReader,
            injectableRegistry, refEmitter, isCore, strictCtorDeps, semanticDepGraphUpdater,
          this.closureCompilerEnabled, /** compileUndecoratedClassesWithAngularFeatures */ false,
          this.delegatingPerfRecorder,
        ) as Readonly<DecoratorHandler<unknown, unknown, SemanticSymbol | null,unknown>>,
      // clang-format on
      // Pipe handler must be before injectable handler in list so pipe factories are printed
      // before injectable factories (so injectable factories can delegate to them)
      new PipeDecoratorHandler(
          reflector, evaluator, metaRegistry, ngModuleScopeRegistry, injectableRegistry, isCore,
          this.delegatingPerfRecorder),
      new InjectableDecoratorHandler(
          reflector, evaluator, isCore, strictCtorDeps, injectableRegistry,
          this.delegatingPerfRecorder),
      new NgModuleDecoratorHandler(
          reflector, evaluator, metaReader, metaRegistry, ngModuleScopeRegistry, referencesRegistry,
          isCore, refEmitter, this.adapter.factoryTracker, this.closureCompilerEnabled,
          this.options.onlyPublishPublicTypingsForNgModules ?? false, injectableRegistry,
          this.delegatingPerfRecorder),
    ];

    const traitCompiler = new TraitCompiler(
        handlers, reflector, this.delegatingPerfRecorder, this.incrementalCompilation,
        this.options.compileNonExportedClasses !== false, compilationMode, dtsTransforms,
        semanticDepGraphUpdater, this.adapter);

    // Template type-checking may use the `ProgramDriver` to produce new `ts.Program`(s). If this
    // happens, they need to be tracked by the `NgCompiler`.
    const notifyingDriver =
        new NotifyingProgramDriverWrapper(this.programDriver, (program: ts.Program) => {
          this.incrementalStrategy.setIncrementalState(this.incrementalCompilation.state, program);
          this.currentProgram = program;
        });

    const templateTypeChecker = new TemplateTypeCheckerImpl(
        this.inputProgram, notifyingDriver, traitCompiler, this.getTypeCheckingConfig(), refEmitter,
        reflector, this.adapter, this.incrementalCompilation, metaReader, localMetaReader,
        scopeReader, typeCheckScopeRegistry, this.delegatingPerfRecorder);

    // Only construct the extended template checker if the configuration is valid and usable.
    const extendedTemplateChecker = this.constructionDiagnostics.length === 0 ?
        new ExtendedTemplateCheckerImpl(
            templateTypeChecker, checker, ALL_DIAGNOSTIC_FACTORIES, this.options) :
        null;

    return {
      isCore,
      traitCompiler,
      reflector,
      scopeRegistry: ngModuleScopeRegistry,
      dtsTransforms,
      exportReferenceGraph,
      metaReader,
      typeCheckScopeRegistry,
      aliasingHost,
      refEmitter,
      templateTypeChecker,
      resourceRegistry,
      extendedTemplateChecker
    };
  }
}

/**
 * Determine if the given `Program` is @angular/core.
 *
 * 确定给定的 `Program` 是否为 @angular/core 。
 *
 */
export function isAngularCorePackage(program: ts.Program): boolean {
  // Look for its_just_angular.ts somewhere in the program.
  const r3Symbols = getR3SymbolsFile(program);
  if (r3Symbols === null) {
    return false;
  }

  // Look for the constant ITS_JUST_ANGULAR in that file.
  return r3Symbols.statements.some(stmt => {
    // The statement must be a variable declaration statement.
    if (!ts.isVariableStatement(stmt)) {
      return false;
    }
    // It must be exported.
    const modifiers = getModifiers(stmt);
    if (modifiers === undefined ||
        !modifiers.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword)) {
      return false;
    }
    // It must declare ITS_JUST_ANGULAR.
    return stmt.declarationList.declarations.some(decl => {
      // The declaration must match the name.
      if (!ts.isIdentifier(decl.name) || decl.name.text !== 'ITS_JUST_ANGULAR') {
        return false;
      }
      // It must initialize the variable to true.
      if (decl.initializer === undefined || decl.initializer.kind !== ts.SyntaxKind.TrueKeyword) {
        return false;
      }
      // This definition matches.
      return true;
    });
  });
}

/**
 * Find the 'r3_symbols.ts' file in the given `Program`, or return `null` if it wasn't there.
 *
 * 在给定的 `Program` 中查找 “r3_symbols.ts” 文件，如果不存在，则返回 `null` 。
 *
 */
function getR3SymbolsFile(program: ts.Program): ts.SourceFile|null {
  return program.getSourceFiles().find(file => file.fileName.indexOf('r3_symbols.ts') >= 0) || null;
}

/**
 * Since "strictTemplates" is a true superset of type checking capabilities compared to
 * "fullTemplateTypeCheck", it is required that the latter is not explicitly disabled if the
 * former is enabled.
 *
 * 由于与“fullTemplateTypeCheck”相比，“strictTemplates”是类型检查特性的真正超集，因此如果启用了前者，则要求不显式禁用后者。
 *
 */
function*
    verifyCompatibleTypeCheckOptions(options: NgCompilerOptions):
        Generator<ts.Diagnostic, void, void> {
  if (options.fullTemplateTypeCheck === false && options.strictTemplates === true) {
    yield makeConfigDiagnostic({
      category: ts.DiagnosticCategory.Error,
      code: ErrorCode.CONFIG_STRICT_TEMPLATES_IMPLIES_FULL_TEMPLATE_TYPECHECK,
      messageText: `
Angular compiler option "strictTemplates" is enabled, however "fullTemplateTypeCheck" is disabled.

Having the "strictTemplates" flag enabled implies that "fullTemplateTypeCheck" is also enabled, so
the latter can not be explicitly disabled.

One of the following actions is required:
1. Remove the "fullTemplateTypeCheck" option.
2. Remove "strictTemplates" or set it to 'false'.

More information about the template type checking compiler options can be found in the documentation:
https://angular.io/guide/template-typecheck
      `.trim(),
    });
  }

  if (options.extendedDiagnostics && options.strictTemplates === false) {
    yield makeConfigDiagnostic({
      category: ts.DiagnosticCategory.Error,
      code: ErrorCode.CONFIG_EXTENDED_DIAGNOSTICS_IMPLIES_STRICT_TEMPLATES,
      messageText: `
Angular compiler option "extendedDiagnostics" is configured, however "strictTemplates" is disabled.

Using "extendedDiagnostics" requires that "strictTemplates" is also enabled.

One of the following actions is required:
1. Remove "strictTemplates: false" to enable it.
2. Remove "extendedDiagnostics" configuration to disable them.
      `.trim(),
    });
  }

  const allowedCategoryLabels = Array.from(Object.values(DiagnosticCategoryLabel)) as string[];
  const defaultCategory = options.extendedDiagnostics?.defaultCategory;
  if (defaultCategory && !allowedCategoryLabels.includes(defaultCategory)) {
    yield makeConfigDiagnostic({
      category: ts.DiagnosticCategory.Error,
      code: ErrorCode.CONFIG_EXTENDED_DIAGNOSTICS_UNKNOWN_CATEGORY_LABEL,
      messageText: `
Angular compiler option "extendedDiagnostics.defaultCategory" has an unknown diagnostic category: "${
                       defaultCategory}".

Allowed diagnostic categories are:
${allowedCategoryLabels.join('\n')}
      `.trim(),
    });
  }

  const allExtendedDiagnosticNames =
      ALL_DIAGNOSTIC_FACTORIES.map((factory) => factory.name) as string[];
  for (const [checkName, category] of Object.entries(options.extendedDiagnostics?.checks ?? {})) {
    if (!allExtendedDiagnosticNames.includes(checkName)) {
      yield makeConfigDiagnostic({
        category: ts.DiagnosticCategory.Error,
        code: ErrorCode.CONFIG_EXTENDED_DIAGNOSTICS_UNKNOWN_CHECK,
        messageText: `
Angular compiler option "extendedDiagnostics.checks" has an unknown check: "${checkName}".

Allowed check names are:
${allExtendedDiagnosticNames.join('\n')}
        `.trim(),
      });
    }

    if (!allowedCategoryLabels.includes(category)) {
      yield makeConfigDiagnostic({
        category: ts.DiagnosticCategory.Error,
        code: ErrorCode.CONFIG_EXTENDED_DIAGNOSTICS_UNKNOWN_CATEGORY_LABEL,
        messageText: `
Angular compiler option "extendedDiagnostics.checks['${
                         checkName}']" has an unknown diagnostic category: "${category}".

Allowed diagnostic categories are:
${allowedCategoryLabels.join('\n')}
        `.trim(),
      });
    }
  }
}

function makeConfigDiagnostic({category, code, messageText}: {
  category: ts.DiagnosticCategory,
  code: ErrorCode,
  messageText: string,
}): ts.Diagnostic {
  return {
    category,
    code: ngErrorCode(code),
    file: undefined,
    start: undefined,
    length: undefined,
    messageText,
  };
}

class ReferenceGraphAdapter implements ReferencesRegistry {
  constructor(private graph: ReferenceGraph) {}

  add(source: DeclarationNode, ...references: Reference<DeclarationNode>[]): void {
    for (const {node} of references) {
      let sourceFile = node.getSourceFile();
      if (sourceFile === undefined) {
        sourceFile = ts.getOriginalNode(node).getSourceFile();
      }

      // Only record local references (not references into .d.ts files).
      if (sourceFile === undefined || !isDtsPath(sourceFile.fileName)) {
        this.graph.add(source, node);
      }
    }
  }
}

class NotifyingProgramDriverWrapper implements ProgramDriver {
  constructor(
      private delegate: ProgramDriver, private notifyNewProgram: (program: ts.Program) => void) {}

  get supportsInlineOperations() {
    return this.delegate.supportsInlineOperations;
  }

  getProgram(): ts.Program {
    return this.delegate.getProgram();
  }

  updateFiles(contents: Map<AbsoluteFsPath, FileUpdate>, updateMode: UpdateMode): void {
    this.delegate.updateFiles(contents, updateMode);
    this.notifyNewProgram(this.delegate.getProgram());
  }

  getSourceFileVersion = this.delegate.getSourceFileVersion?.bind(this);
}

function versionMapFromProgram(
    program: ts.Program, driver: ProgramDriver): Map<AbsoluteFsPath, string>|null {
  if (driver.getSourceFileVersion === undefined) {
    return null;
  }

  const versions = new Map<AbsoluteFsPath, string>();
  for (const possiblyRedirectedSourceFile of program.getSourceFiles()) {
    const sf = toUnredirectedSourceFile(possiblyRedirectedSourceFile);
    versions.set(absoluteFromSourceFile(sf), driver.getSourceFileVersion(sf));
  }
  return versions;
}
