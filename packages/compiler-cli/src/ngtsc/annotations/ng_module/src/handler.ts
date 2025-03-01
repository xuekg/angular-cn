/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {compileClassMetadata, compileDeclareClassMetadata, compileDeclareInjectorFromMetadata, compileDeclareNgModuleFromMetadata, compileInjector, compileNgModule, Expression, ExternalExpr, FactoryTarget, FunctionExpr, InvokeFunctionExpr, LiteralArrayExpr, R3ClassMetadata, R3CompiledExpression, R3FactoryMetadata, R3Identifiers, R3InjectorMetadata, R3NgModuleMetadata, R3Reference, R3SelectorScopeMode, ReturnStatement, SchemaMetadata, Statement, WrappedNodeExpr} from '@angular/compiler';
import ts from 'typescript';

import {ErrorCode, FatalDiagnosticError, makeDiagnostic, makeRelatedInformation} from '../../../diagnostics';
import {assertSuccessfulReferenceEmit, Reference, ReferenceEmitter} from '../../../imports';
import {isArrayEqual, isReferenceEqual, isSymbolEqual, SemanticReference, SemanticSymbol} from '../../../incremental/semantic_graph';
import {MetadataReader, MetadataRegistry, MetaKind} from '../../../metadata';
import {PartialEvaluator, ResolvedValue, SyntheticValue} from '../../../partial_evaluator';
import {PerfEvent, PerfRecorder} from '../../../perf';
import {ClassDeclaration, DeclarationNode, Decorator, isNamedClassDeclaration, ReflectionHost, reflectObjectLiteral} from '../../../reflection';
import {LocalModuleScopeRegistry, ScopeData} from '../../../scope';
import {getDiagnosticNode} from '../../../scope/src/util';
import {FactoryTracker} from '../../../shims/api';
import {AnalysisOutput, CompileResult, DecoratorHandler, DetectResult, HandlerPrecedence, ResolveResult} from '../../../transform';
import {getSourceFile} from '../../../util/src/typescript';
import {combineResolvers, compileDeclareFactory, compileNgFactoryDefField, createValueHasWrongTypeError, extractClassMetadata, extractSchemas, findAngularDecorator, forwardRefResolver, getProviderDiagnostics, getValidConstructorDependencies, InjectableClassRegistry, isExpressionForwardReference, ReferencesRegistry, resolveProvidersRequiringFactory, toR3Reference, unwrapExpression, wrapFunctionExpressionsInParens, wrapTypeReference} from '../../common';

import {createModuleWithProvidersResolver, isResolvedModuleWithProviders} from './module_with_providers';

export interface NgModuleAnalysis {
  mod: R3NgModuleMetadata;
  inj: Omit<R3InjectorMetadata, 'imports'>;
  fac: R3FactoryMetadata;
  classMetadata: R3ClassMetadata|null;
  declarations: Reference<ClassDeclaration>[];
  rawDeclarations: ts.Expression|null;
  schemas: SchemaMetadata[];
  imports: TopLevelImportedExpression[];
  importRefs: Reference<ClassDeclaration>[];
  rawImports: ts.Expression|null;
  exports: Reference<ClassDeclaration>[];
  rawExports: ts.Expression|null;
  id: Expression|null;
  factorySymbolName: string;
  providersRequiringFactory: Set<Reference<ClassDeclaration>>|null;
  providers: ts.Expression|null;
  remoteScopesMayRequireCycleProtection: boolean;
  decorator: ts.Decorator|null;
}

export interface NgModuleResolution {
  injectorImports: Expression[];
}

/**
 * Represents an Angular NgModule.
 *
 * 表示一个 Angular NgModule。
 *
 */
export class NgModuleSymbol extends SemanticSymbol {
  private remotelyScopedComponents: {
    component: SemanticSymbol,
    usedDirectives: SemanticReference[],
    usedPipes: SemanticReference[]
  }[] = [];

  override isPublicApiAffected(previousSymbol: SemanticSymbol): boolean {
    if (!(previousSymbol instanceof NgModuleSymbol)) {
      return true;
    }

    // NgModules don't have a public API that could affect emit of Angular decorated classes.
    return false;
  }

  override isEmitAffected(previousSymbol: SemanticSymbol): boolean {
    if (!(previousSymbol instanceof NgModuleSymbol)) {
      return true;
    }

    // compare our remotelyScopedComponents to the previous symbol
    if (previousSymbol.remotelyScopedComponents.length !== this.remotelyScopedComponents.length) {
      return true;
    }

    for (const currEntry of this.remotelyScopedComponents) {
      const prevEntry = previousSymbol.remotelyScopedComponents.find(prevEntry => {
        return isSymbolEqual(prevEntry.component, currEntry.component);
      });

      if (prevEntry === undefined) {
        // No previous entry was found, which means that this component became remotely scoped and
        // hence this NgModule needs to be re-emitted.
        return true;
      }

      if (!isArrayEqual(currEntry.usedDirectives, prevEntry.usedDirectives, isReferenceEqual)) {
        // The list of used directives or their order has changed. Since this NgModule emits
        // references to the list of used directives, it should be re-emitted to update this list.
        // Note: the NgModule does not have to be re-emitted when any of the directives has had
        // their public API changed, as the NgModule only emits a reference to the symbol by its
        // name. Therefore, testing for symbol equality is sufficient.
        return true;
      }

      if (!isArrayEqual(currEntry.usedPipes, prevEntry.usedPipes, isReferenceEqual)) {
        return true;
      }
    }
    return false;
  }

  override isTypeCheckApiAffected(previousSymbol: SemanticSymbol): boolean {
    if (!(previousSymbol instanceof NgModuleSymbol)) {
      return true;
    }

    return false;
  }

  addRemotelyScopedComponent(
      component: SemanticSymbol, usedDirectives: SemanticReference[],
      usedPipes: SemanticReference[]): void {
    this.remotelyScopedComponents.push({component, usedDirectives, usedPipes});
  }
}

/**
 * Compiles @NgModule annotations to ngModuleDef fields.
 *
 * 将 @NgModule 注解编译为 ngModuleDef 字段。
 *
 */
export class NgModuleDecoratorHandler implements
    DecoratorHandler<Decorator, NgModuleAnalysis, NgModuleSymbol, NgModuleResolution> {
  constructor(
      private reflector: ReflectionHost, private evaluator: PartialEvaluator,
      private metaReader: MetadataReader, private metaRegistry: MetadataRegistry,
      private scopeRegistry: LocalModuleScopeRegistry,
      private referencesRegistry: ReferencesRegistry, private isCore: boolean,
      private refEmitter: ReferenceEmitter, private factoryTracker: FactoryTracker|null,
      private annotateForClosureCompiler: boolean, private onlyPublishPublicTypings: boolean,
      private injectableRegistry: InjectableClassRegistry, private perf: PerfRecorder) {}

  readonly precedence = HandlerPrecedence.PRIMARY;
  readonly name = NgModuleDecoratorHandler.name;

  detect(node: ClassDeclaration, decorators: Decorator[]|null): DetectResult<Decorator>|undefined {
    if (!decorators) {
      return undefined;
    }
    const decorator = findAngularDecorator(decorators, 'NgModule', this.isCore);
    if (decorator !== undefined) {
      return {
        trigger: decorator.node,
        decorator: decorator,
        metadata: decorator,
      };
    } else {
      return undefined;
    }
  }

  analyze(node: ClassDeclaration, decorator: Readonly<Decorator>):
      AnalysisOutput<NgModuleAnalysis> {
    this.perf.eventCount(PerfEvent.AnalyzeNgModule);

    const name = node.name.text;
    if (decorator.args === null || decorator.args.length > 1) {
      throw new FatalDiagnosticError(
          ErrorCode.DECORATOR_ARITY_WRONG, Decorator.nodeForError(decorator),
          `Incorrect number of arguments to @NgModule decorator`);
    }

    // @NgModule can be invoked without arguments. In case it is, pretend as if a blank object
    // literal was specified. This simplifies the code below.
    const meta = decorator.args.length === 1 ? unwrapExpression(decorator.args[0]) :
                                               ts.factory.createObjectLiteralExpression([]);

    if (!ts.isObjectLiteralExpression(meta)) {
      throw new FatalDiagnosticError(
          ErrorCode.DECORATOR_ARG_NOT_LITERAL, meta,
          '@NgModule argument must be an object literal');
    }
    const ngModule = reflectObjectLiteral(meta);

    if (ngModule.has('jit')) {
      // The only allowed value is true, so there's no need to expand further.
      return {};
    }

    const moduleResolvers = combineResolvers([
      createModuleWithProvidersResolver(this.reflector, this.isCore),
      forwardRefResolver,
    ]);

    const diagnostics: ts.Diagnostic[] = [];

    // Extract the module declarations, imports, and exports.
    let declarationRefs: Reference<ClassDeclaration>[] = [];
    let rawDeclarations: ts.Expression|null = null;
    if (ngModule.has('declarations')) {
      rawDeclarations = ngModule.get('declarations')!;
      const declarationMeta = this.evaluator.evaluate(rawDeclarations, forwardRefResolver);
      declarationRefs =
          this.resolveTypeList(rawDeclarations, declarationMeta, name, 'declarations', 0)
              .references;

      // Look through the declarations to make sure they're all a part of the current compilation.
      for (const ref of declarationRefs) {
        if (ref.node.getSourceFile().isDeclarationFile) {
          const errorNode = ref.getOriginForDiagnostics(rawDeclarations);

          diagnostics.push(makeDiagnostic(
              ErrorCode.NGMODULE_INVALID_DECLARATION, errorNode,
              `Cannot declare '${
                  ref.node.name
                      .text}' in an NgModule as it's not a part of the current compilation.`,
              [makeRelatedInformation(
                  ref.node.name, `'${ref.node.name.text}' is declared here.`)]));
        }
      }
    }

    if (diagnostics.length > 0) {
      return {diagnostics};
    }

    let importRefs: Reference<ClassDeclaration>[] = [];
    let rawImports: ts.Expression|null = null;
    if (ngModule.has('imports')) {
      rawImports = ngModule.get('imports')!;
      const importsMeta = this.evaluator.evaluate(rawImports, moduleResolvers);
      importRefs = this.resolveTypeList(rawImports, importsMeta, name, 'imports', 0).references;
    }
    let exportRefs: Reference<ClassDeclaration>[] = [];
    let rawExports: ts.Expression|null = null;
    if (ngModule.has('exports')) {
      rawExports = ngModule.get('exports')!;
      const exportsMeta = this.evaluator.evaluate(rawExports, moduleResolvers);
      exportRefs = this.resolveTypeList(rawExports, exportsMeta, name, 'exports', 0).references;
      this.referencesRegistry.add(node, ...exportRefs);
    }
    let bootstrapRefs: Reference<ClassDeclaration>[] = [];
    if (ngModule.has('bootstrap')) {
      const expr = ngModule.get('bootstrap')!;
      const bootstrapMeta = this.evaluator.evaluate(expr, forwardRefResolver);
      bootstrapRefs = this.resolveTypeList(expr, bootstrapMeta, name, 'bootstrap', 0).references;

      // Verify that the `@NgModule.bootstrap` list doesn't have Standalone Components.
      for (const ref of bootstrapRefs) {
        const dirMeta = this.metaReader.getDirectiveMetadata(ref);
        if (dirMeta?.isStandalone) {
          diagnostics.push(makeStandaloneBootstrapDiagnostic(node, ref, expr));
        }
      }
    }

    const schemas = ngModule.has('schemas') ?
        extractSchemas(ngModule.get('schemas')!, this.evaluator, 'NgModule') :
        [];

    let id: Expression|null = null;
    if (ngModule.has('id')) {
      const idExpr = ngModule.get('id')!;
      if (!isModuleIdExpression(idExpr)) {
        id = new WrappedNodeExpr(idExpr);
      } else {
        const diag = makeDiagnostic(
            ErrorCode.WARN_NGMODULE_ID_UNNECESSARY, idExpr,
            `Using 'module.id' for NgModule.id is a common anti-pattern that is ignored by the Angular compiler.`);
        diag.category = ts.DiagnosticCategory.Warning;
        diagnostics.push(diag);
      }
    }

    const valueContext = node.getSourceFile();

    let typeContext = valueContext;
    const typeNode = this.reflector.getDtsDeclaration(node);
    if (typeNode !== null) {
      typeContext = typeNode.getSourceFile();
    }


    const exportedNodes = new Set(exportRefs.map(ref => ref.node));
    const declarations: R3Reference[] = [];
    const exportedDeclarations: Expression[] = [];

    const bootstrap = bootstrapRefs.map(
        bootstrap => this._toR3Reference(
            bootstrap.getOriginForDiagnostics(meta, node.name), bootstrap, valueContext,
            typeContext));

    for (const ref of declarationRefs) {
      const decl = this._toR3Reference(
          ref.getOriginForDiagnostics(meta, node.name), ref, valueContext, typeContext);
      declarations.push(decl);
      if (exportedNodes.has(ref.node)) {
        exportedDeclarations.push(decl.type);
      }
    }
    const imports = importRefs.map(
        imp => this._toR3Reference(
            imp.getOriginForDiagnostics(meta, node.name), imp, valueContext, typeContext));
    const exports = exportRefs.map(
        exp => this._toR3Reference(
            exp.getOriginForDiagnostics(meta, node.name), exp, valueContext, typeContext));


    const isForwardReference = (ref: R3Reference) =>
        isExpressionForwardReference(ref.value, node.name!, valueContext);
    const containsForwardDecls = bootstrap.some(isForwardReference) ||
        declarations.some(isForwardReference) || imports.some(isForwardReference) ||
        exports.some(isForwardReference);

    const type = wrapTypeReference(this.reflector, node);
    const internalType = new WrappedNodeExpr(this.reflector.getInternalNameOfClass(node));
    const adjacentType = new WrappedNodeExpr(this.reflector.getAdjacentNameOfClass(node));

    const ngModuleMetadata: R3NgModuleMetadata = {
      type,
      internalType,
      adjacentType,
      bootstrap,
      declarations,
      publicDeclarationTypes: this.onlyPublishPublicTypings ? exportedDeclarations : null,
      exports,
      imports,
      // Imported types are generally private, so include them unless restricting the .d.ts emit to
      // only public types.
      includeImportTypes: !this.onlyPublishPublicTypings,
      containsForwardDecls,
      id,
      // Use `ɵɵsetNgModuleScope` to patch selector scopes onto the generated definition in a
      // tree-shakeable way.
      selectorScopeMode: R3SelectorScopeMode.SideEffect,
      // TODO: to be implemented as a part of FW-1004.
      schemas: [],
    };

    const rawProviders = ngModule.has('providers') ? ngModule.get('providers')! : null;
    let wrappedProviders: WrappedNodeExpr<ts.Expression>|null = null;

    // In most cases the providers will be an array literal. Check if it has any elements
    // and don't include the providers if it doesn't which saves us a few bytes.
    if (rawProviders !== null &&
        (!ts.isArrayLiteralExpression(rawProviders) || rawProviders.elements.length > 0)) {
      wrappedProviders = new WrappedNodeExpr(
          this.annotateForClosureCompiler ? wrapFunctionExpressionsInParens(rawProviders) :
                                            rawProviders);
    }

    const topLevelImports: TopLevelImportedExpression[] = [];
    if (ngModule.has('imports')) {
      const rawImports = unwrapExpression(ngModule.get('imports')!);

      let topLevelExpressions: ts.Expression[] = [];
      if (ts.isArrayLiteralExpression(rawImports)) {
        for (const element of rawImports.elements) {
          if (ts.isSpreadElement(element)) {
            // Because `imports` allows nested arrays anyway, a spread expression (`...foo`) can be
            // treated the same as a direct reference to `foo`.
            topLevelExpressions.push(element.expression);
            continue;
          }
          topLevelExpressions.push(element);
        }
      } else {
        // Treat the whole `imports` expression as top-level.
        topLevelExpressions.push(rawImports);
      }

      let absoluteIndex = 0;
      for (const importExpr of topLevelExpressions) {
        const resolved = this.evaluator.evaluate(importExpr, moduleResolvers);

        const {references, hasModuleWithProviders} =
            this.resolveTypeList(importExpr, [resolved], node.name.text, 'imports', absoluteIndex);
        absoluteIndex += references.length;

        topLevelImports.push({
          expression: importExpr,
          resolvedReferences: references,
          hasModuleWithProviders,
        });
      }
    }

    const injectorMetadata: Omit<R3InjectorMetadata, 'imports'> = {
      name,
      type,
      internalType,
      providers: wrappedProviders,
    };

    const factoryMetadata: R3FactoryMetadata = {
      name,
      type,
      internalType,
      typeArgumentCount: 0,
      deps: getValidConstructorDependencies(node, this.reflector, this.isCore),
      target: FactoryTarget.NgModule,
    };

    // Remote scoping is used when adding imports to a component file would create a cycle. In such
    // circumstances the component scope is monkey-patched from the NgModule file instead.
    //
    // However, if the NgModule itself has a cycle with the desired component/directive
    // reference(s), then we need to be careful. This can happen for example if an NgModule imports
    // a standalone component and the component also imports the NgModule.
    //
    // In this case, it'd be tempting to rely on the compiler's cycle detector to automatically put
    // such circular references behind a function/closure. This requires global knowledge of the
    // import graph though, and we don't want to depend on such techniques for new APIs like
    // standalone components.
    //
    // Instead, we look for `forwardRef`s in the NgModule dependencies - an explicit signal from the
    // user that a reference may not be defined until a circular import is resolved. If an NgModule
    // contains forward-referenced declarations or imports, we assume that remotely scoped
    // components should also guard against cycles using a closure-wrapped scope.
    //
    // The actual detection here is done heuristically. The compiler doesn't actually know whether
    // any given `Reference` came from a `forwardRef`, but it does know when a `Reference` came from
    // a `ForeignFunctionResolver` _like_ the `forwardRef` resolver. So we know when it's safe to
    // not use a closure, and will use one just in case otherwise.
    const remoteScopesMayRequireCycleProtection =
        declarationRefs.some(isSyntheticReference) || importRefs.some(isSyntheticReference);

    return {
      diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
      analysis: {
        id,
        schemas,
        mod: ngModuleMetadata,
        inj: injectorMetadata,
        fac: factoryMetadata,
        declarations: declarationRefs,
        rawDeclarations,
        imports: topLevelImports,
        rawImports,
        importRefs,
        exports: exportRefs,
        rawExports,
        providers: rawProviders,
        providersRequiringFactory: rawProviders ?
            resolveProvidersRequiringFactory(rawProviders, this.reflector, this.evaluator) :
            null,
        classMetadata: extractClassMetadata(
            node, this.reflector, this.isCore, this.annotateForClosureCompiler),
        factorySymbolName: node.name.text,
        remoteScopesMayRequireCycleProtection,
        decorator: decorator?.node as ts.Decorator | null ?? null,
      },
    };
  }

  symbol(node: ClassDeclaration): NgModuleSymbol {
    return new NgModuleSymbol(node);
  }

  register(node: ClassDeclaration, analysis: NgModuleAnalysis): void {
    // Register this module's information with the LocalModuleScopeRegistry. This ensures that
    // during the compile() phase, the module's metadata is available for selector scope
    // computation.
    this.metaRegistry.registerNgModuleMetadata({
      kind: MetaKind.NgModule,
      ref: new Reference(node),
      schemas: analysis.schemas,
      declarations: analysis.declarations,
      imports: analysis.importRefs,
      exports: analysis.exports,
      rawDeclarations: analysis.rawDeclarations,
      rawImports: analysis.rawImports,
      rawExports: analysis.rawExports,
      decorator: analysis.decorator,
    });

    if (this.factoryTracker !== null) {
      this.factoryTracker.track(node.getSourceFile(), {
        name: analysis.factorySymbolName,
      });
    }

    this.injectableRegistry.registerInjectable(node, {
      ctorDeps: analysis.fac.deps,
    });
  }

  resolve(node: ClassDeclaration, analysis: Readonly<NgModuleAnalysis>):
      ResolveResult<NgModuleResolution> {
    const scope = this.scopeRegistry.getScopeOfModule(node);
    const diagnostics: ts.Diagnostic[] = [];

    const scopeDiagnostics = this.scopeRegistry.getDiagnosticsOfModule(node);
    if (scopeDiagnostics !== null) {
      diagnostics.push(...scopeDiagnostics);
    }

    if (analysis.providersRequiringFactory !== null) {
      const providerDiagnostics = getProviderDiagnostics(
          analysis.providersRequiringFactory, analysis.providers!, this.injectableRegistry);
      diagnostics.push(...providerDiagnostics);
    }

    const data: NgModuleResolution = {
      injectorImports: [],
    };

    // Add all top-level imports from the `imports` field to the injector imports.
    for (const topLevelImport of analysis.imports) {
      if (topLevelImport.hasModuleWithProviders) {
        // We have no choice but to emit expressions which contain MWPs, as we cannot filter on
        // individual references.
        data.injectorImports.push(new WrappedNodeExpr(topLevelImport.expression));
        continue;
      }

      const refsToEmit: Reference<ClassDeclaration>[] = [];
      for (const ref of topLevelImport.resolvedReferences) {
        const dirMeta = this.metaReader.getDirectiveMetadata(ref);
        if (dirMeta !== null && !dirMeta.isComponent) {
          // Skip emit of directives in imports - directives can't carry providers.
          continue;
        }

        const pipeMeta = dirMeta === null ? this.metaReader.getPipeMetadata(ref) : null;
        if (pipeMeta !== null) {
          // Skip emit of pipes in imports - pipes can't carry providers.
          continue;
        }

        refsToEmit.push(ref);
      }

      if (refsToEmit.length === topLevelImport.resolvedReferences.length) {
        // All references within this top-level import should be emitted, so just use the user's
        // expression.
        data.injectorImports.push(new WrappedNodeExpr(topLevelImport.expression));
      } else {
        // Some references have been filtered out. Emit references to individual classes.
        const context = node.getSourceFile();
        for (const ref of refsToEmit) {
          const emittedRef = this.refEmitter.emit(ref, context);
          assertSuccessfulReferenceEmit(emittedRef, topLevelImport.expression, 'class');
          data.injectorImports.push(emittedRef.expression);
        }
      }
    }

    if (scope !== null && !scope.compilation.isPoisoned) {
      // Using the scope information, extend the injector's imports using the modules that are
      // specified as module exports.
      const context = getSourceFile(node);
      for (const exportRef of analysis.exports) {
        if (isNgModule(exportRef.node, scope.compilation)) {
          const type = this.refEmitter.emit(exportRef, context);
          assertSuccessfulReferenceEmit(type, node, 'NgModule');
          data.injectorImports.push(type.expression);
        }
      }

      for (const decl of analysis.declarations) {
        const dirMeta = this.metaReader.getDirectiveMetadata(decl);
        if (dirMeta !== null) {
          const refType = dirMeta.isComponent ? 'Component' : 'Directive';

          if (dirMeta.selector === null) {
            throw new FatalDiagnosticError(
                ErrorCode.DIRECTIVE_MISSING_SELECTOR, decl.node,
                `${refType} ${decl.node.name.text} has no selector, please add it!`);
          }

          continue;
        }
      }
    }

    if (diagnostics.length > 0) {
      return {diagnostics};
    }

    if (scope === null || scope.compilation.isPoisoned || scope.exported.isPoisoned ||
        scope.reexports === null) {
      return {data};
    } else {
      return {
        data,
        reexports: scope.reexports,
      };
    }
  }

  compileFull(
      node: ClassDeclaration,
      {inj, mod, fac, classMetadata, declarations, remoteScopesMayRequireCycleProtection}:
          Readonly<NgModuleAnalysis>,
      {injectorImports}: Readonly<NgModuleResolution>): CompileResult[] {
    const factoryFn = compileNgFactoryDefField(fac);
    const ngInjectorDef = compileInjector({
      ...inj,
      imports: injectorImports,
    });
    const ngModuleDef = compileNgModule(mod);
    const statements = ngModuleDef.statements;
    const metadata = classMetadata !== null ? compileClassMetadata(classMetadata) : null;
    this.insertMetadataStatement(statements, metadata);
    this.appendRemoteScopingStatements(
        statements, node, declarations, remoteScopesMayRequireCycleProtection);

    return this.compileNgModule(factoryFn, ngInjectorDef, ngModuleDef);
  }

  compilePartial(
      node: ClassDeclaration, {inj, fac, mod, classMetadata}: Readonly<NgModuleAnalysis>,
      {injectorImports}: Readonly<NgModuleResolution>): CompileResult[] {
    const factoryFn = compileDeclareFactory(fac);
    const injectorDef = compileDeclareInjectorFromMetadata({
      ...inj,
      imports: injectorImports,
    });
    const ngModuleDef = compileDeclareNgModuleFromMetadata(mod);
    const metadata = classMetadata !== null ? compileDeclareClassMetadata(classMetadata) : null;
    this.insertMetadataStatement(ngModuleDef.statements, metadata);
    // NOTE: no remote scoping required as this is banned in partial compilation.
    return this.compileNgModule(factoryFn, injectorDef, ngModuleDef);
  }

  /**
   * Add class metadata statements, if provided, to the `ngModuleStatements`.
   *
   * 将类元数据语句（如果提供）添加到 `ngModuleStatements` 。
   *
   */
  private insertMetadataStatement(ngModuleStatements: Statement[], metadata: Expression|null):
      void {
    if (metadata !== null) {
      ngModuleStatements.unshift(metadata.toStmt());
    }
  }

  /**
   * Add remote scoping statements, as needed, to the `ngModuleStatements`.
   *
   * 根据需要，将远程范围声明添加到 `ngModuleStatements` 。
   *
   */
  private appendRemoteScopingStatements(
      ngModuleStatements: Statement[], node: ClassDeclaration,
      declarations: Reference<ClassDeclaration>[],
      remoteScopesMayRequireCycleProtection: boolean): void {
    const context = getSourceFile(node);
    for (const decl of declarations) {
      const remoteScope = this.scopeRegistry.getRemoteScope(decl.node);
      if (remoteScope !== null) {
        const directives = remoteScope.directives.map(directive => {
          const type = this.refEmitter.emit(directive, context);
          assertSuccessfulReferenceEmit(type, node, 'directive');
          return type.expression;
        });
        const pipes = remoteScope.pipes.map(pipe => {
          const type = this.refEmitter.emit(pipe, context);
          assertSuccessfulReferenceEmit(type, node, 'pipe');
          return type.expression;
        });
        const directiveArray = new LiteralArrayExpr(directives);
        const pipesArray = new LiteralArrayExpr(pipes);

        const directiveExpr = remoteScopesMayRequireCycleProtection && directives.length > 0 ?
            new FunctionExpr([], [new ReturnStatement(directiveArray)]) :
            directiveArray;
        const pipesExpr = remoteScopesMayRequireCycleProtection && pipes.length > 0 ?
            new FunctionExpr([], [new ReturnStatement(pipesArray)]) :
            pipesArray;
        const componentType = this.refEmitter.emit(decl, context);
        assertSuccessfulReferenceEmit(componentType, node, 'component');
        const declExpr = componentType.expression;
        const setComponentScope = new ExternalExpr(R3Identifiers.setComponentScope);
        const callExpr =
            new InvokeFunctionExpr(setComponentScope, [declExpr, directiveExpr, pipesExpr]);

        ngModuleStatements.push(callExpr.toStmt());
      }
    }
  }

  private compileNgModule(
      factoryFn: CompileResult, injectorDef: R3CompiledExpression,
      ngModuleDef: R3CompiledExpression): CompileResult[] {
    const res: CompileResult[] = [
      factoryFn,
      {
        name: 'ɵmod',
        initializer: ngModuleDef.expression,
        statements: ngModuleDef.statements,
        type: ngModuleDef.type,
      },
      {
        name: 'ɵinj',
        initializer: injectorDef.expression,
        statements: injectorDef.statements,
        type: injectorDef.type,
      },
    ];
    return res;
  }

  private _toR3Reference(
      origin: ts.Node, valueRef: Reference<ClassDeclaration>, valueContext: ts.SourceFile,
      typeContext: ts.SourceFile): R3Reference {
    if (valueRef.hasOwningModuleGuess) {
      return toR3Reference(origin, valueRef, valueRef, valueContext, valueContext, this.refEmitter);
    } else {
      let typeRef = valueRef;
      let typeNode = this.reflector.getDtsDeclaration(typeRef.node);
      if (typeNode !== null && isNamedClassDeclaration(typeNode)) {
        typeRef = new Reference(typeNode);
      }
      return toR3Reference(origin, valueRef, typeRef, valueContext, typeContext, this.refEmitter);
    }
  }

  // Verify that a "Declaration" reference is a `ClassDeclaration` reference.
  private isClassDeclarationReference(ref: Reference): ref is Reference<ClassDeclaration> {
    return this.reflector.isClass(ref.node);
  }

  /**
   * Compute a list of `Reference`s from a resolved metadata value.
   *
   * 从解析的元数据值计算 `Reference` 列表。
   *
   */
  private resolveTypeList(
      expr: ts.Node, resolvedList: ResolvedValue, className: string, arrayName: string,
      absoluteIndex: number):
      {references: Reference<ClassDeclaration>[], hasModuleWithProviders: boolean} {
    let hasModuleWithProviders = false;
    const refList: Reference<ClassDeclaration>[] = [];
    if (!Array.isArray(resolvedList)) {
      throw createValueHasWrongTypeError(
          expr, resolvedList,
          `Expected array when reading the NgModule.${arrayName} of ${className}`);
    }

    for (let idx = 0; idx < resolvedList.length; idx++) {
      let entry = resolvedList[idx];
      // Unwrap ModuleWithProviders for modules that are locally declared (and thus static
      // resolution was able to descend into the function and return an object literal, a Map).
      if (entry instanceof SyntheticValue && isResolvedModuleWithProviders(entry)) {
        entry = entry.value.ngModule;
        hasModuleWithProviders = true;
      } else if (entry instanceof Map && entry.has('ngModule')) {
        entry = entry.get('ngModule')!;
        hasModuleWithProviders = true;
      }

      if (Array.isArray(entry)) {
        // Recurse into nested arrays.
        const recursiveResult =
            this.resolveTypeList(expr, entry, className, arrayName, absoluteIndex);
        refList.push(...recursiveResult.references);
        absoluteIndex += recursiveResult.references.length;
        hasModuleWithProviders = hasModuleWithProviders || recursiveResult.hasModuleWithProviders;
      } else if (entry instanceof Reference) {
        if (!this.isClassDeclarationReference(entry)) {
          throw createValueHasWrongTypeError(
              entry.node, entry,
              `Value at position ${absoluteIndex} in the NgModule.${arrayName} of ${
                  className} is not a class`);
        }
        refList.push(entry);
        absoluteIndex += 1;
      } else {
        // TODO(alxhub): Produce a better diagnostic here - the array index may be an inner array.
        throw createValueHasWrongTypeError(
            expr, entry,
            `Value at position ${absoluteIndex} in the NgModule.${arrayName} of ${
                className} is not a reference`);
      }
    }

    return {
      references: refList,
      hasModuleWithProviders,
    };
  }
}

function isNgModule(node: ClassDeclaration, compilation: ScopeData): boolean {
  return !compilation.dependencies.some(dep => dep.ref.node === node);
}

/**
 * Checks whether the given `ts.Expression` is the expression `module.id`.
 *
 * 检查给定的 `ts.Expression` 是否是表达式 `module.id` 。
 *
 */
function isModuleIdExpression(expr: ts.Expression): boolean {
  return ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) &&
      expr.expression.text === 'module' && expr.name.text === 'id';
}

export interface TopLevelImportedExpression {
  expression: ts.Expression;
  resolvedReferences: Array<Reference<ClassDeclaration>>;
  hasModuleWithProviders: boolean;
}

/**
 * Helper method to produce a diagnostics for a situation when a standalone component
 * is referenced in the `@NgModule.bootstrap` array.
 *
 * 在 `@NgModule.bootstrap` 数组中引用独立组件时，为这种情况生成诊断的帮助器方法。
 *
 */
function makeStandaloneBootstrapDiagnostic(
    ngModuleClass: ClassDeclaration, bootstrappedClassRef: Reference<ClassDeclaration>,
    rawBootstrapExpr: ts.Expression|null): ts.Diagnostic {
  const componentClassName = bootstrappedClassRef.node.name.text;
  // Note: this error message should be aligned with the one produced by JIT.
  const message =  //
      `The \`${componentClassName}\` class is a standalone component, which can ` +
      `not be used in the \`@NgModule.bootstrap\` array. Use the \`bootstrapApplication\` ` +
      `function for bootstrap instead.`;
  const relatedInformation: ts.DiagnosticRelatedInformation[]|undefined =
      [makeRelatedInformation(ngModuleClass, `The 'bootstrap' array is present on this NgModule.`)];

  return makeDiagnostic(
      ErrorCode.NGMODULE_BOOTSTRAP_IS_STANDALONE,
      getDiagnosticNode(bootstrappedClassRef, rawBootstrapExpr), message, relatedInformation);
}

function isSyntheticReference(ref: Reference<DeclarationNode>): boolean {
  return ref.synthetic;
}
