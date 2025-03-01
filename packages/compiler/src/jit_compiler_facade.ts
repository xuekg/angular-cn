/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */


import {CompilerFacade, CoreEnvironment, ExportedCompilerFacade, OpaqueValue, R3ComponentMetadataFacade, R3DeclareComponentFacade, R3DeclareDependencyMetadataFacade, R3DeclareDirectiveDependencyFacade, R3DeclareDirectiveFacade, R3DeclareFactoryFacade, R3DeclareInjectableFacade, R3DeclareInjectorFacade, R3DeclareNgModuleFacade, R3DeclarePipeDependencyFacade, R3DeclarePipeFacade, R3DeclareQueryMetadataFacade, R3DependencyMetadataFacade, R3DirectiveMetadataFacade, R3FactoryDefMetadataFacade, R3InjectableMetadataFacade, R3InjectorMetadataFacade, R3NgModuleMetadataFacade, R3PipeMetadataFacade, R3QueryMetadataFacade, R3TemplateDependencyFacade, StringMap, StringMapWithRename} from './compiler_facade_interface';
import {ConstantPool} from './constant_pool';
import {ChangeDetectionStrategy, HostBinding, HostListener, Input, Output, ViewEncapsulation} from './core';
import {compileInjectable} from './injectable_compiler_2';
import {DEFAULT_INTERPOLATION_CONFIG, InterpolationConfig} from './ml_parser/interpolation_config';
import {DeclareVarStmt, Expression, literal, LiteralExpr, Statement, StmtModifier, WrappedNodeExpr} from './output/output_ast';
import {JitEvaluator} from './output/output_jit';
import {ParseError, ParseSourceSpan, r3JitTypeSourceSpan} from './parse_util';
import {compileFactoryFunction, FactoryTarget, R3DependencyMetadata} from './render3/r3_factory';
import {compileInjector, R3InjectorMetadata} from './render3/r3_injector_compiler';
import {R3JitReflector} from './render3/r3_jit';
import {compileNgModule, compileNgModuleDeclarationExpression, R3NgModuleMetadata, R3SelectorScopeMode} from './render3/r3_module_compiler';
import {compilePipeFromMetadata, R3PipeMetadata} from './render3/r3_pipe_compiler';
import {createMayBeForwardRefExpression, ForwardRefHandling, getSafePropertyAccessString, MaybeForwardRefExpression, wrapReference} from './render3/util';
import {DeclarationListEmitMode, R3ComponentMetadata, R3DirectiveDependencyMetadata, R3DirectiveMetadata, R3HostDirectiveMetadata, R3HostMetadata, R3PipeDependencyMetadata, R3QueryMetadata, R3TemplateDependency, R3TemplateDependencyKind, R3TemplateDependencyMetadata} from './render3/view/api';
import {compileComponentFromMetadata, compileDirectiveFromMetadata, ParsedHostBindings, parseHostBindings, verifyHostBindings} from './render3/view/compiler';
import {makeBindingParser, parseTemplate} from './render3/view/template';
import {ResourceLoader} from './resource_loader';
import {DomElementSchemaRegistry} from './schema/dom_element_schema_registry';

export class CompilerFacadeImpl implements CompilerFacade {
  FactoryTarget = FactoryTarget as any;
  ResourceLoader = ResourceLoader;
  private elementSchemaRegistry = new DomElementSchemaRegistry();

  constructor(private jitEvaluator = new JitEvaluator()) {}

  compilePipe(angularCoreEnv: CoreEnvironment, sourceMapUrl: string, facade: R3PipeMetadataFacade):
      any {
    const metadata: R3PipeMetadata = {
      name: facade.name,
      type: wrapReference(facade.type),
      internalType: new WrappedNodeExpr(facade.type),
      typeArgumentCount: 0,
      deps: null,
      pipeName: facade.pipeName,
      pure: facade.pure,
      isStandalone: facade.isStandalone,
    };
    const res = compilePipeFromMetadata(metadata);
    return this.jitExpression(res.expression, angularCoreEnv, sourceMapUrl, []);
  }

  compilePipeDeclaration(
      angularCoreEnv: CoreEnvironment, sourceMapUrl: string,
      declaration: R3DeclarePipeFacade): any {
    const meta = convertDeclarePipeFacadeToMetadata(declaration);
    const res = compilePipeFromMetadata(meta);
    return this.jitExpression(res.expression, angularCoreEnv, sourceMapUrl, []);
  }

  compileInjectable(
      angularCoreEnv: CoreEnvironment, sourceMapUrl: string,
      facade: R3InjectableMetadataFacade): any {
    const {expression, statements} = compileInjectable(
        {
          name: facade.name,
          type: wrapReference(facade.type),
          internalType: new WrappedNodeExpr(facade.type),
          typeArgumentCount: facade.typeArgumentCount,
          providedIn: computeProvidedIn(facade.providedIn),
          useClass: convertToProviderExpression(facade, 'useClass'),
          useFactory: wrapExpression(facade, 'useFactory'),
          useValue: convertToProviderExpression(facade, 'useValue'),
          useExisting: convertToProviderExpression(facade, 'useExisting'),
          deps: facade.deps?.map(convertR3DependencyMetadata),
        },
        /* resolveForwardRefs */ true);

    return this.jitExpression(expression, angularCoreEnv, sourceMapUrl, statements);
  }

  compileInjectableDeclaration(
      angularCoreEnv: CoreEnvironment, sourceMapUrl: string,
      facade: R3DeclareInjectableFacade): any {
    const {expression, statements} = compileInjectable(
        {
          name: facade.type.name,
          type: wrapReference(facade.type),
          internalType: new WrappedNodeExpr(facade.type),
          typeArgumentCount: 0,
          providedIn: computeProvidedIn(facade.providedIn),
          useClass: convertToProviderExpression(facade, 'useClass'),
          useFactory: wrapExpression(facade, 'useFactory'),
          useValue: convertToProviderExpression(facade, 'useValue'),
          useExisting: convertToProviderExpression(facade, 'useExisting'),
          deps: facade.deps?.map(convertR3DeclareDependencyMetadata),
        },
        /* resolveForwardRefs */ true);

    return this.jitExpression(expression, angularCoreEnv, sourceMapUrl, statements);
  }

  compileInjector(
      angularCoreEnv: CoreEnvironment, sourceMapUrl: string,
      facade: R3InjectorMetadataFacade): any {
    const meta: R3InjectorMetadata = {
      name: facade.name,
      type: wrapReference(facade.type),
      internalType: new WrappedNodeExpr(facade.type),
      providers: facade.providers && facade.providers.length > 0 ?
          new WrappedNodeExpr(facade.providers) :
          null,
      imports: facade.imports.map(i => new WrappedNodeExpr(i)),
    };
    const res = compileInjector(meta);
    return this.jitExpression(res.expression, angularCoreEnv, sourceMapUrl, []);
  }

  compileInjectorDeclaration(
      angularCoreEnv: CoreEnvironment, sourceMapUrl: string,
      declaration: R3DeclareInjectorFacade): any {
    const meta = convertDeclareInjectorFacadeToMetadata(declaration);
    const res = compileInjector(meta);
    return this.jitExpression(res.expression, angularCoreEnv, sourceMapUrl, []);
  }

  compileNgModule(
      angularCoreEnv: CoreEnvironment, sourceMapUrl: string,
      facade: R3NgModuleMetadataFacade): any {
    const meta: R3NgModuleMetadata = {
      type: wrapReference(facade.type),
      internalType: new WrappedNodeExpr(facade.type),
      adjacentType: new WrappedNodeExpr(facade.type),
      bootstrap: facade.bootstrap.map(wrapReference),
      declarations: facade.declarations.map(wrapReference),
      publicDeclarationTypes: null,  // only needed for types in AOT
      imports: facade.imports.map(wrapReference),
      includeImportTypes: true,
      exports: facade.exports.map(wrapReference),
      selectorScopeMode: R3SelectorScopeMode.Inline,
      containsForwardDecls: false,
      schemas: facade.schemas ? facade.schemas.map(wrapReference) : null,
      id: facade.id ? new WrappedNodeExpr(facade.id) : null,
    };
    const res = compileNgModule(meta);
    return this.jitExpression(res.expression, angularCoreEnv, sourceMapUrl, []);
  }

  compileNgModuleDeclaration(
      angularCoreEnv: CoreEnvironment, sourceMapUrl: string,
      declaration: R3DeclareNgModuleFacade): any {
    const expression = compileNgModuleDeclarationExpression(declaration);
    return this.jitExpression(expression, angularCoreEnv, sourceMapUrl, []);
  }

  compileDirective(
      angularCoreEnv: CoreEnvironment, sourceMapUrl: string,
      facade: R3DirectiveMetadataFacade): any {
    const meta: R3DirectiveMetadata = convertDirectiveFacadeToMetadata(facade);
    return this.compileDirectiveFromMeta(angularCoreEnv, sourceMapUrl, meta);
  }

  compileDirectiveDeclaration(
      angularCoreEnv: CoreEnvironment, sourceMapUrl: string,
      declaration: R3DeclareDirectiveFacade): any {
    const typeSourceSpan =
        this.createParseSourceSpan('Directive', declaration.type.name, sourceMapUrl);
    const meta = convertDeclareDirectiveFacadeToMetadata(declaration, typeSourceSpan);
    return this.compileDirectiveFromMeta(angularCoreEnv, sourceMapUrl, meta);
  }

  private compileDirectiveFromMeta(
      angularCoreEnv: CoreEnvironment, sourceMapUrl: string, meta: R3DirectiveMetadata): any {
    const constantPool = new ConstantPool();
    const bindingParser = makeBindingParser();
    const res = compileDirectiveFromMetadata(meta, constantPool, bindingParser);
    return this.jitExpression(
        res.expression, angularCoreEnv, sourceMapUrl, constantPool.statements);
  }

  compileComponent(
      angularCoreEnv: CoreEnvironment, sourceMapUrl: string,
      facade: R3ComponentMetadataFacade): any {
    // Parse the template and check for errors.
    const {template, interpolation} = parseJitTemplate(
        facade.template, facade.name, sourceMapUrl, facade.preserveWhitespaces,
        facade.interpolation);

    // Compile the component metadata, including template, into an expression.
    const meta: R3ComponentMetadata<R3TemplateDependency> = {
      ...facade as R3ComponentMetadataFacadeNoPropAndWhitespace,
      ...convertDirectiveFacadeToMetadata(facade),
      selector: facade.selector || this.elementSchemaRegistry.getDefaultComponentElementName(),
      template,
      declarations: facade.declarations.map(convertDeclarationFacadeToMetadata),
      declarationListEmitMode: DeclarationListEmitMode.Direct,
      styles: [...facade.styles, ...template.styles],
      encapsulation: facade.encapsulation as any,
      interpolation,
      changeDetection: facade.changeDetection,
      animations: facade.animations != null ? new WrappedNodeExpr(facade.animations) : null,
      viewProviders: facade.viewProviders != null ? new WrappedNodeExpr(facade.viewProviders) :
                                                    null,
      relativeContextFilePath: '',
      i18nUseExternalIds: true,
    };
    const jitExpressionSourceMap = `ng:///${facade.name}.js`;
    return this.compileComponentFromMeta(angularCoreEnv, jitExpressionSourceMap, meta);
  }

  compileComponentDeclaration(
      angularCoreEnv: CoreEnvironment, sourceMapUrl: string,
      declaration: R3DeclareComponentFacade): any {
    const typeSourceSpan =
        this.createParseSourceSpan('Component', declaration.type.name, sourceMapUrl);
    const meta = convertDeclareComponentFacadeToMetadata(declaration, typeSourceSpan, sourceMapUrl);
    return this.compileComponentFromMeta(angularCoreEnv, sourceMapUrl, meta);
  }

  private compileComponentFromMeta(
      angularCoreEnv: CoreEnvironment, sourceMapUrl: string,
      meta: R3ComponentMetadata<R3TemplateDependency>): any {
    const constantPool = new ConstantPool();
    const bindingParser = makeBindingParser(meta.interpolation);
    const res = compileComponentFromMetadata(meta, constantPool, bindingParser);
    return this.jitExpression(
        res.expression, angularCoreEnv, sourceMapUrl, constantPool.statements);
  }

  compileFactory(
      angularCoreEnv: CoreEnvironment, sourceMapUrl: string, meta: R3FactoryDefMetadataFacade) {
    const factoryRes = compileFactoryFunction({
      name: meta.name,
      type: wrapReference(meta.type),
      internalType: new WrappedNodeExpr(meta.type),
      typeArgumentCount: meta.typeArgumentCount,
      deps: convertR3DependencyMetadataArray(meta.deps),
      target: meta.target,
    });
    return this.jitExpression(
        factoryRes.expression, angularCoreEnv, sourceMapUrl, factoryRes.statements);
  }

  compileFactoryDeclaration(
      angularCoreEnv: CoreEnvironment, sourceMapUrl: string, meta: R3DeclareFactoryFacade) {
    const factoryRes = compileFactoryFunction({
      name: meta.type.name,
      type: wrapReference(meta.type),
      internalType: new WrappedNodeExpr(meta.type),
      typeArgumentCount: 0,
      deps: Array.isArray(meta.deps) ? meta.deps.map(convertR3DeclareDependencyMetadata) :
                                       meta.deps,
      target: meta.target,
    });
    return this.jitExpression(
        factoryRes.expression, angularCoreEnv, sourceMapUrl, factoryRes.statements);
  }


  createParseSourceSpan(kind: string, typeName: string, sourceUrl: string): ParseSourceSpan {
    return r3JitTypeSourceSpan(kind, typeName, sourceUrl);
  }

  /**
   * JIT compiles an expression and returns the result of executing that expression.
   *
   * JIT 会编译一个表达式并返回执行该表达式的结果。
   *
   * @param def the definition which will be compiled and executed to get the value to patch
   *
   * 将被编译和执行以获取要 patch 的值的定义
   *
   * @param context an object map of @angular/core symbol names to symbols which will be available
   * in the context of the compiled expression
   *
   * 一个 @angular/core 符号名到符号的对象映射表，它们将在编译表达式的上下文中可用
   *
   * @param sourceUrl a URL to use for the source map of the compiled expression
   *
   * 用于已编译表达式的源映射的 URL
   *
   * @param preStatements a collection of statements that should be evaluated before the expression.
   *
   * 应该在表达式之前估算的语句的集合。
   *
   */
  private jitExpression(
      def: Expression, context: {[key: string]: any}, sourceUrl: string,
      preStatements: Statement[]): any {
    // The ConstantPool may contain Statements which declare variables used in the final expression.
    // Therefore, its statements need to precede the actual JIT operation. The final statement is a
    // declaration of $def which is set to the expression being compiled.
    const statements: Statement[] = [
      ...preStatements,
      new DeclareVarStmt('$def', def, undefined, StmtModifier.Exported),
    ];

    const res = this.jitEvaluator.evaluateStatements(
        sourceUrl, statements, new R3JitReflector(context), /* enableSourceMaps */ true);
    return res['$def'];
  }
}

// This seems to be needed to placate TS v3.0 only
type R3ComponentMetadataFacadeNoPropAndWhitespace = Pick<
    R3ComponentMetadataFacade,
    Exclude<Exclude<keyof R3ComponentMetadataFacade, 'preserveWhitespaces'>, 'propMetadata'>>;

function convertToR3QueryMetadata(facade: R3QueryMetadataFacade): R3QueryMetadata {
  return {
    ...facade,
    predicate: convertQueryPredicate(facade.predicate),
    read: facade.read ? new WrappedNodeExpr(facade.read) : null,
    static: facade.static,
    emitDistinctChangesOnly: facade.emitDistinctChangesOnly,
  };
}

function convertQueryDeclarationToMetadata(declaration: R3DeclareQueryMetadataFacade):
    R3QueryMetadata {
  return {
    propertyName: declaration.propertyName,
    first: declaration.first ?? false,
    predicate: convertQueryPredicate(declaration.predicate),
    descendants: declaration.descendants ?? false,
    read: declaration.read ? new WrappedNodeExpr(declaration.read) : null,
    static: declaration.static ?? false,
    emitDistinctChangesOnly: declaration.emitDistinctChangesOnly ?? true,
  };
}

function convertQueryPredicate(predicate: OpaqueValue|string[]): MaybeForwardRefExpression|
    string[] {
  return Array.isArray(predicate) ?
      // The predicate is an array of strings so pass it through.
      predicate :
      // The predicate is a type - assume that we will need to unwrap any `forwardRef()` calls.
      createMayBeForwardRefExpression(new WrappedNodeExpr(predicate), ForwardRefHandling.Wrapped);
}

function convertDirectiveFacadeToMetadata(facade: R3DirectiveMetadataFacade): R3DirectiveMetadata {
  const inputsFromMetadata = parseInputOutputs(facade.inputs || []);
  const outputsFromMetadata = parseInputOutputs(facade.outputs || []);
  const propMetadata = facade.propMetadata;
  const inputsFromType: StringMapWithRename = {};
  const outputsFromType: StringMap = {};
  for (const field in propMetadata) {
    if (propMetadata.hasOwnProperty(field)) {
      propMetadata[field].forEach(ann => {
        if (isInput(ann)) {
          inputsFromType[field] =
              ann.bindingPropertyName ? [ann.bindingPropertyName, field] : field;
        } else if (isOutput(ann)) {
          outputsFromType[field] = ann.bindingPropertyName || field;
        }
      });
    }
  }

  return {
    ...facade as R3DirectiveMetadataFacadeNoPropAndWhitespace,
    typeArgumentCount: 0,
    typeSourceSpan: facade.typeSourceSpan,
    type: wrapReference(facade.type),
    internalType: new WrappedNodeExpr(facade.type),
    deps: null,
    host: extractHostBindings(facade.propMetadata, facade.typeSourceSpan, facade.host),
    inputs: {...inputsFromMetadata, ...inputsFromType},
    outputs: {...outputsFromMetadata, ...outputsFromType},
    queries: facade.queries.map(convertToR3QueryMetadata),
    providers: facade.providers != null ? new WrappedNodeExpr(facade.providers) : null,
    viewQueries: facade.viewQueries.map(convertToR3QueryMetadata),
    fullInheritance: false,
    hostDirectives: convertHostDirectivesToMetadata(facade),
  };
}

function convertDeclareDirectiveFacadeToMetadata(
    declaration: R3DeclareDirectiveFacade, typeSourceSpan: ParseSourceSpan): R3DirectiveMetadata {
  return {
    name: declaration.type.name,
    type: wrapReference(declaration.type),
    typeSourceSpan,
    internalType: new WrappedNodeExpr(declaration.type),
    selector: declaration.selector ?? null,
    inputs: declaration.inputs ?? {},
    outputs: declaration.outputs ?? {},
    host: convertHostDeclarationToMetadata(declaration.host),
    queries: (declaration.queries ?? []).map(convertQueryDeclarationToMetadata),
    viewQueries: (declaration.viewQueries ?? []).map(convertQueryDeclarationToMetadata),
    providers: declaration.providers !== undefined ? new WrappedNodeExpr(declaration.providers) :
                                                     null,
    exportAs: declaration.exportAs ?? null,
    usesInheritance: declaration.usesInheritance ?? false,
    lifecycle: {usesOnChanges: declaration.usesOnChanges ?? false},
    deps: null,
    typeArgumentCount: 0,
    fullInheritance: false,
    isStandalone: declaration.isStandalone ?? false,
    hostDirectives: convertHostDirectivesToMetadata(declaration),
  };
}

function convertHostDeclarationToMetadata(host: R3DeclareDirectiveFacade['host'] = {}):
    R3HostMetadata {
  return {
    attributes: convertOpaqueValuesToExpressions(host.attributes ?? {}),
    listeners: host.listeners ?? {},
    properties: host.properties ?? {},
    specialAttributes: {
      classAttr: host.classAttribute,
      styleAttr: host.styleAttribute,
    },
  };
}

function convertHostDirectivesToMetadata(
    metadata: R3DeclareDirectiveFacade|R3DirectiveMetadataFacade): R3HostDirectiveMetadata[]|null {
  if (metadata.hostDirectives?.length) {
    return metadata.hostDirectives.map(hostDirective => {
      return typeof hostDirective === 'function' ?
          {
            directive: wrapReference(hostDirective),
            inputs: null,
            outputs: null,
            isForwardReference: false
          } :
          {
            directive: wrapReference(hostDirective.directive),
            isForwardReference: false,
            inputs: hostDirective.inputs ? parseInputOutputs(hostDirective.inputs) : null,
            outputs: hostDirective.outputs ? parseInputOutputs(hostDirective.outputs) : null,
          };
    });
  }

  return null;
}

function convertOpaqueValuesToExpressions(obj: {[key: string]: OpaqueValue}):
    {[key: string]: WrappedNodeExpr<unknown>} {
  const result: {[key: string]: WrappedNodeExpr<unknown>} = {};
  for (const key of Object.keys(obj)) {
    result[key] = new WrappedNodeExpr(obj[key]);
  }
  return result;
}

function convertDeclareComponentFacadeToMetadata(
    decl: R3DeclareComponentFacade, typeSourceSpan: ParseSourceSpan,
    sourceMapUrl: string): R3ComponentMetadata<R3TemplateDependencyMetadata> {
  const {template, interpolation} = parseJitTemplate(
      decl.template, decl.type.name, sourceMapUrl, decl.preserveWhitespaces ?? false,
      decl.interpolation);

  const declarations: R3TemplateDependencyMetadata[] = [];
  if (decl.dependencies) {
    for (const innerDep of decl.dependencies) {
      switch (innerDep.kind) {
        case 'directive':
        case 'component':
          declarations.push(convertDirectiveDeclarationToMetadata(innerDep));
          break;
        case 'pipe':
          declarations.push(convertPipeDeclarationToMetadata(innerDep));
          break;
      }
    }
  } else if (decl.components || decl.directives || decl.pipes) {
    // Existing declarations on NPM may not be using the new `dependencies` merged field, and may
    // have separate fields for dependencies instead. Unify them for JIT compilation.
    decl.components &&
        declarations.push(...decl.components.map(
            dir => convertDirectiveDeclarationToMetadata(dir, /* isComponent */ true)));
    decl.directives &&
        declarations.push(
            ...decl.directives.map(dir => convertDirectiveDeclarationToMetadata(dir)));
    decl.pipes && declarations.push(...convertPipeMapToMetadata(decl.pipes));
  }

  return {
    ...convertDeclareDirectiveFacadeToMetadata(decl, typeSourceSpan),
    template,
    styles: decl.styles ?? [],
    declarations,
    viewProviders: decl.viewProviders !== undefined ? new WrappedNodeExpr(decl.viewProviders) :
                                                      null,
    animations: decl.animations !== undefined ? new WrappedNodeExpr(decl.animations) : null,
    changeDetection: decl.changeDetection ?? ChangeDetectionStrategy.Default,
    encapsulation: decl.encapsulation ?? ViewEncapsulation.Emulated,
    interpolation,
    declarationListEmitMode: DeclarationListEmitMode.ClosureResolved,
    relativeContextFilePath: '',
    i18nUseExternalIds: true,
  };
}

function convertDeclarationFacadeToMetadata(declaration: R3TemplateDependencyFacade):
    R3TemplateDependency {
  return {
    ...declaration,
    type: new WrappedNodeExpr(declaration.type),
  };
}

function convertDirectiveDeclarationToMetadata(
    declaration: R3DeclareDirectiveDependencyFacade,
    isComponent: true|null = null): R3DirectiveDependencyMetadata {
  return {
    kind: R3TemplateDependencyKind.Directive,
    isComponent: isComponent || declaration.kind === 'component',
    selector: declaration.selector,
    type: new WrappedNodeExpr(declaration.type),
    inputs: declaration.inputs ?? [],
    outputs: declaration.outputs ?? [],
    exportAs: declaration.exportAs ?? null,
  };
}

function convertPipeMapToMetadata(pipes: R3DeclareComponentFacade['pipes']):
    R3PipeDependencyMetadata[] {
  if (!pipes) {
    return [];
  }

  return Object.keys(pipes).map(name => {
    return {
      kind: R3TemplateDependencyKind.Pipe,
      name,
      type: new WrappedNodeExpr(pipes[name]),
    };
  });
}

function convertPipeDeclarationToMetadata(pipe: R3DeclarePipeDependencyFacade):
    R3PipeDependencyMetadata {
  return {
    kind: R3TemplateDependencyKind.Pipe,
    name: pipe.name,
    type: new WrappedNodeExpr(pipe.type),
  };
}

function parseJitTemplate(
    template: string, typeName: string, sourceMapUrl: string, preserveWhitespaces: boolean,
    interpolation: [string, string]|undefined) {
  const interpolationConfig =
      interpolation ? InterpolationConfig.fromArray(interpolation) : DEFAULT_INTERPOLATION_CONFIG;
  // Parse the template and check for errors.
  const parsed = parseTemplate(template, sourceMapUrl, {preserveWhitespaces, interpolationConfig});
  if (parsed.errors !== null) {
    const errors = parsed.errors.map(err => err.toString()).join(', ');
    throw new Error(`Errors during JIT compilation of template for ${typeName}: ${errors}`);
  }
  return {template: parsed, interpolation: interpolationConfig};
}

// This seems to be needed to placate TS v3.0 only
type R3DirectiveMetadataFacadeNoPropAndWhitespace =
    Pick<R3DirectiveMetadataFacade, Exclude<keyof R3DirectiveMetadataFacade, 'propMetadata'>>;

/**
 * Convert the expression, if present to an `R3ProviderExpression`.
 *
 * 将表达式（如果存在）转换为 `R3ProviderExpression` 。
 *
 * In JIT mode we do not want the compiler to wrap the expression in a `forwardRef()` call because,
 * if it is referencing a type that has not yet been defined, it will have already been wrapped in
 * a `forwardRef()` - either by the application developer or during partial-compilation. Thus we can
 * use `ForwardRefHandling.None`.
 *
 * 在 JIT 模式下，我们不希望编译器将表达式包装在 `forwardRef()`
 * 调用中，因为如果它引用了一个尚未定义的类型，它将已经被包装在 `forwardRef()` 中 -
 * 要么是由应用程序开发人员或在部分编译期间。因此我们可以用 `ForwardRefHandling.None` 。
 *
 */
function convertToProviderExpression(obj: any, property: string): MaybeForwardRefExpression|
    undefined {
  if (obj.hasOwnProperty(property)) {
    return createMayBeForwardRefExpression(
        new WrappedNodeExpr(obj[property]), ForwardRefHandling.None);
  } else {
    return undefined;
  }
}

function wrapExpression(obj: any, property: string): WrappedNodeExpr<any>|undefined {
  if (obj.hasOwnProperty(property)) {
    return new WrappedNodeExpr(obj[property]);
  } else {
    return undefined;
  }
}

function computeProvidedIn(providedIn: Function|string|null|undefined): MaybeForwardRefExpression {
  const expression = typeof providedIn === 'function' ? new WrappedNodeExpr(providedIn) :
                                                        new LiteralExpr(providedIn ?? null);
  // See `convertToProviderExpression()` for why this uses `ForwardRefHandling.None`.
  return createMayBeForwardRefExpression(expression, ForwardRefHandling.None);
}

function convertR3DependencyMetadataArray(facades: R3DependencyMetadataFacade[]|null|
                                          undefined): R3DependencyMetadata[]|null {
  return facades == null ? null : facades.map(convertR3DependencyMetadata);
}

function convertR3DependencyMetadata(facade: R3DependencyMetadataFacade): R3DependencyMetadata {
  const isAttributeDep = facade.attribute != null;  // both `null` and `undefined`
  const rawToken = facade.token === null ? null : new WrappedNodeExpr(facade.token);
  // In JIT mode, if the dep is an `@Attribute()` then we use the attribute name given in
  // `attribute` rather than the `token`.
  const token = isAttributeDep ? new WrappedNodeExpr(facade.attribute) : rawToken;
  return createR3DependencyMetadata(
      token, isAttributeDep, facade.host, facade.optional, facade.self, facade.skipSelf);
}

function convertR3DeclareDependencyMetadata(facade: R3DeclareDependencyMetadataFacade):
    R3DependencyMetadata {
  const isAttributeDep = facade.attribute ?? false;
  const token = facade.token === null ? null : new WrappedNodeExpr(facade.token);
  return createR3DependencyMetadata(
      token, isAttributeDep, facade.host ?? false, facade.optional ?? false, facade.self ?? false,
      facade.skipSelf ?? false);
}

function createR3DependencyMetadata(
    token: WrappedNodeExpr<unknown>|null, isAttributeDep: boolean, host: boolean, optional: boolean,
    self: boolean, skipSelf: boolean): R3DependencyMetadata {
  // If the dep is an `@Attribute()` the `attributeNameType` ought to be the `unknown` type.
  // But types are not available at runtime so we just use a literal `"<unknown>"` string as a dummy
  // marker.
  const attributeNameType = isAttributeDep ? literal('unknown') : null;
  return {token, attributeNameType, host, optional, self, skipSelf};
}

function extractHostBindings(
    propMetadata: {[key: string]: any[]}, sourceSpan: ParseSourceSpan,
    host?: {[key: string]: string}): ParsedHostBindings {
  // First parse the declarations from the metadata.
  const bindings = parseHostBindings(host || {});

  // After that check host bindings for errors
  const errors = verifyHostBindings(bindings, sourceSpan);
  if (errors.length) {
    throw new Error(errors.map((error: ParseError) => error.msg).join('\n'));
  }

  // Next, loop over the properties of the object, looking for @HostBinding and @HostListener.
  for (const field in propMetadata) {
    if (propMetadata.hasOwnProperty(field)) {
      propMetadata[field].forEach(ann => {
        if (isHostBinding(ann)) {
          // Since this is a decorator, we know that the value is a class member. Always access it
          // through `this` so that further down the line it can't be confused for a literal value
          // (e.g. if there's a property called `true`).
          bindings.properties[ann.hostPropertyName || field] =
              getSafePropertyAccessString('this', field);
        } else if (isHostListener(ann)) {
          bindings.listeners[ann.eventName || field] = `${field}(${(ann.args || []).join(',')})`;
        }
      });
    }
  }

  return bindings;
}

function isHostBinding(value: any): value is HostBinding {
  return value.ngMetadataName === 'HostBinding';
}

function isHostListener(value: any): value is HostListener {
  return value.ngMetadataName === 'HostListener';
}


function isInput(value: any): value is Input {
  return value.ngMetadataName === 'Input';
}

function isOutput(value: any): value is Output {
  return value.ngMetadataName === 'Output';
}

function parseInputOutputs(values: string[]): StringMap {
  return values.reduce((results, value) => {
    const [field, property] = value.split(':', 2).map(str => str.trim());
    results[field] = property || field;
    return results;
  }, {} as StringMap);
}

function convertDeclarePipeFacadeToMetadata(declaration: R3DeclarePipeFacade): R3PipeMetadata {
  return {
    name: declaration.type.name,
    type: wrapReference(declaration.type),
    internalType: new WrappedNodeExpr(declaration.type),
    typeArgumentCount: 0,
    pipeName: declaration.name,
    deps: null,
    pure: declaration.pure ?? true,
    isStandalone: declaration.isStandalone ?? false,
  };
}

function convertDeclareInjectorFacadeToMetadata(declaration: R3DeclareInjectorFacade):
    R3InjectorMetadata {
  return {
    name: declaration.type.name,
    type: wrapReference(declaration.type),
    internalType: new WrappedNodeExpr(declaration.type),
    providers: declaration.providers !== undefined && declaration.providers.length > 0 ?
        new WrappedNodeExpr(declaration.providers) :
        null,
    imports: declaration.imports !== undefined ?
        declaration.imports.map(i => new WrappedNodeExpr(i)) :
        [],
  };
}

export function publishFacade(global: any) {
  const ng: ExportedCompilerFacade = global.ng || (global.ng = {});
  ng.ɵcompilerFacade = new CompilerFacadeImpl();
}
