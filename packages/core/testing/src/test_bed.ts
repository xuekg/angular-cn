/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

// The formatter and CI disagree on how this import statement should be formatted. Both try to keep
// it on one line, too, which has gotten very hard to read & manage. So disable the formatter for
// this statement only.

/* clang-format off */
import {
  Component,
  Directive,
  InjectFlags,
  InjectionToken,
  InjectOptions,
  Injector,
  NgModule,
  NgZone,
  Pipe,
  PlatformRef,
  ProviderToken,
  Type,
  ɵconvertToBitFlags as convertToBitFlags,
  ɵflushModuleScopingQueueAsMuchAsPossible as flushModuleScopingQueueAsMuchAsPossible,
  ɵgetUnknownElementStrictMode as getUnknownElementStrictMode,
  ɵgetUnknownPropertyStrictMode as getUnknownPropertyStrictMode,
  ɵRender3ComponentFactory as ComponentFactory,
  ɵRender3NgModuleRef as NgModuleRef,
  ɵresetCompiledComponents as resetCompiledComponents,
  ɵsetAllowDuplicateNgModuleIdsForTest as setAllowDuplicateNgModuleIdsForTest,
  ɵsetUnknownElementStrictMode as setUnknownElementStrictMode,
  ɵsetUnknownPropertyStrictMode as setUnknownPropertyStrictMode,
  ɵstringify as stringify
} from '@angular/core';

/* clang-format on */

import {ComponentFixture} from './component_fixture';
import {MetadataOverride} from './metadata_override';
import {ComponentFixtureAutoDetect, ComponentFixtureNoNgZone, ModuleTeardownOptions, TEARDOWN_TESTING_MODULE_ON_DESTROY_DEFAULT, TestComponentRenderer, TestEnvironmentOptions, TestModuleMetadata, THROW_ON_UNKNOWN_ELEMENTS_DEFAULT, THROW_ON_UNKNOWN_PROPERTIES_DEFAULT} from './test_bed_common';
import {TestBedCompiler} from './test_bed_compiler';

/**
 * Static methods implemented by the `TestBed`.
 *
 * `TestBed` 实现的静态方法。
 *
 * @publicApi
 */
export interface TestBedStatic extends TestBed {
  new(...args: any[]): TestBed;
}

/**
 * @publicApi
 */
export interface TestBed {
  get platform(): PlatformRef;

  get ngModule(): Type<any>|Type<any>[];

  /**
   * Initialize the environment for testing with a compiler factory, a PlatformRef, and an
   * angular module. These are common to every test in the suite.
   *
   * 使用编译器工厂、PlatformRef 和 angular
   * 模块来初始化测试环境。这些对于套件中的每个测试都是公共的。
   *
   * This may only be called once, to set up the common providers for the current test
   * suite on the current platform. If you absolutely need to change the providers,
   * first use `resetTestEnvironment`.
   *
   * 这只能调用一次，以在当前平台上为当前测试套件设置公用提供者。如果你必须要更改提供者，请首先使用
   * `resetTestEnvironment` 。
   *
   * Test modules and platforms for individual platforms are available from
   * '@angular/&lt;platform_name>/testing'.
   *
   * 可从 '@angular/&lt;platform_name>/testing' 获得适用于各个平台的测试模块和平台。
   *
   */
  initTestEnvironment(
      ngModule: Type<any>|Type<any>[], platform: PlatformRef,
      options?: TestEnvironmentOptions): void;

  /**
   * Reset the providers for the test injector.
   *
   * 重置测试注入器的提供者。
   *
   */
  resetTestEnvironment(): void;

  resetTestingModule(): TestBed;

  configureCompiler(config: {providers?: any[], useJit?: boolean}): void;

  configureTestingModule(moduleDef: TestModuleMetadata): TestBed;

  compileComponents(): Promise<any>;

  inject<T>(token: ProviderToken<T>, notFoundValue: undefined, options: InjectOptions&{
    optional?: false
  }): T;
  inject<T>(token: ProviderToken<T>, notFoundValue: null|undefined, options: InjectOptions): T|null;
  inject<T>(token: ProviderToken<T>, notFoundValue?: T, options?: InjectOptions): T;
  /**
 * @deprecated
 *
 * use object-based flags (`InjectOptions`) instead.
 *
 * 改用基于对象的标志 ( `InjectOptions` ) 。
 *
 */
  inject<T>(token: ProviderToken<T>, notFoundValue?: T, flags?: InjectFlags): T;
  /**
 * @deprecated
 *
 * use object-based flags (`InjectOptions`) instead.
 *
 * 改用基于对象的标志 ( `InjectOptions` ) 。
 *
 */
  inject<T>(token: ProviderToken<T>, notFoundValue: null, flags?: InjectFlags): T|null;

  /**
   * @deprecated from v9.0.0 use TestBed.inject
   *
   * 从 v9.0.0 开始使用 TestBed.inject
   *
   */
  get<T>(token: ProviderToken<T>, notFoundValue?: T, flags?: InjectFlags): any;
  /**
   * @deprecated from v9.0.0 use TestBed.inject
   *
   * 从 v9.0.0 开始使用 TestBed.inject
   *
   */
  get(token: any, notFoundValue?: any): any;

  execute(tokens: any[], fn: Function, context?: any): any;

  overrideModule(ngModule: Type<any>, override: MetadataOverride<NgModule>): TestBed;

  overrideComponent(component: Type<any>, override: MetadataOverride<Component>): TestBed;

  overrideDirective(directive: Type<any>, override: MetadataOverride<Directive>): TestBed;

  overridePipe(pipe: Type<any>, override: MetadataOverride<Pipe>): TestBed;

  overrideTemplate(component: Type<any>, template: string): TestBed;

  /**
   * Overwrites all providers for the given token with the given provider definition.
   *
   * 使用给定的提供者定义覆盖给定令牌的所有提供者。
   *
   */
  overrideProvider(token: any, provider: {
    useFactory: Function,
    deps: any[],
  }): TestBed;
  overrideProvider(token: any, provider: {useValue: any;}): TestBed;
  overrideProvider(token: any, provider: {useFactory?: Function, useValue?: any, deps?: any[]}):
      TestBed;

  overrideTemplateUsingTestingModule(component: Type<any>, template: string): TestBed;

  createComponent<T>(component: Type<T>): ComponentFixture<T>;
}

let _nextRootElementId = 0;

/**
 * Returns a singleton of the `TestBed` class.
 *
 * 返回 `TestBed` 类的单例。
 *
 * @publicApi
 */
export function getTestBed(): TestBed {
  return TestBedImpl.INSTANCE;
}

/**
 * @description
 *
 * Configures and initializes environment for unit testing and provides methods for
 * creating components and services in unit tests.
 *
 * 为单元测试配置和初始化环境，并提供在单元测试中创建组件和服务的方法。
 *
 * TestBed is the primary api for writing unit tests for Angular applications and libraries.
 *
 * TestBed 是为 Angular 应用程序和库编写单元测试的主要 api。
 *
 */
export class TestBedImpl implements TestBed {
  private static _INSTANCE: TestBedImpl|null = null;

  static get INSTANCE(): TestBedImpl {
    return TestBedImpl._INSTANCE = TestBedImpl._INSTANCE || new TestBedImpl();
  }

  /**
   * Teardown options that have been configured at the environment level.
   * Used as a fallback if no instance-level options have been provided.
   *
   * 已在环境级别配置的拆卸选项。如果没有提供实例级选项，则用作后备。
   *
   */
  private static _environmentTeardownOptions: ModuleTeardownOptions|undefined;

  /**
   * "Error on unknown elements" option that has been configured at the environment level.
   * Used as a fallback if no instance-level option has been provided.
   *
   * 已在环境级别配置的“未知元素错误”选项。如果没有提供实例级选项，则用作后备。
   *
   */
  private static _environmentErrorOnUnknownElementsOption: boolean|undefined;

  /**
   * "Error on unknown properties" option that has been configured at the environment level.
   * Used as a fallback if no instance-level option has been provided.
   *
   * 已在环境级别配置的“未知属性错误”选项。如果没有提供实例级选项，则用作后备。
   *
   */
  private static _environmentErrorOnUnknownPropertiesOption: boolean|undefined;

  /**
   * Teardown options that have been configured at the `TestBed` instance level.
   * These options take precedence over the environment-level ones.
   *
   * 已在 `TestBed` 实例级别配置的拆卸选项。这些选项优先于环境级别的选项。
   *
   */
  private _instanceTeardownOptions: ModuleTeardownOptions|undefined;

  /**
   * "Error on unknown elements" option that has been configured at the `TestBed` instance level.
   * This option takes precedence over the environment-level one.
   *
   * 已在 `TestBed` 实例级别配置的“未知元素错误”选项。此选项优先于环境级别的选项。
   *
   */
  private _instanceErrorOnUnknownElementsOption: boolean|undefined;

  /**
   * "Error on unknown properties" option that has been configured at the `TestBed` instance level.
   * This option takes precedence over the environment-level one.
   *
   * 已在 `TestBed` 实例级别配置的“未知属性错误”选项。此选项优先于环境级别的选项。
   *
   */
  private _instanceErrorOnUnknownPropertiesOption: boolean|undefined;

  /**
   * Stores the previous "Error on unknown elements" option value,
   * allowing to restore it in the reset testing module logic.
   *
   * 存储以前的“未知元素错误”选项值，允许在重置测试模块逻辑中恢复它。
   *
   */
  private _previousErrorOnUnknownElementsOption: boolean|undefined;

  /**
   * Stores the previous "Error on unknown properties" option value,
   * allowing to restore it in the reset testing module logic.
   *
   * 存储以前的“未知属性错误”选项值，允许在重置测试模块逻辑中恢复它。
   *
   */
  private _previousErrorOnUnknownPropertiesOption: boolean|undefined;

  /**
   * Initialize the environment for testing with a compiler factory, a PlatformRef, and an
   * angular module. These are common to every test in the suite.
   *
   * 使用编译器工厂、PlatformRef 和 Angular 模块初始化用于测试的环境。这些在套件中的每个测试中都是通用的。
   *
   * This may only be called once, to set up the common providers for the current test
   * suite on the current platform. If you absolutely need to change the providers,
   * first use `resetTestEnvironment`.
   *
   * 这可能只会调用一次，以在当前平台上为当前测试套件设置通用提供者。如果你绝对需要更改提供者，请首先使用 `resetTestEnvironment` 。
   *
   * Test modules and platforms for individual platforms are available from
   * '@angular/&lt;platform_name>/testing'.
   *
   * 单个平台的测试模块和平台可从 '@angular/&lt;platform_name>/testing' 获得。
   *
   * @publicApi
   */
  static initTestEnvironment(
      ngModule: Type<any>|Type<any>[], platform: PlatformRef,
      options?: TestEnvironmentOptions): TestBed {
    const testBed = TestBedImpl.INSTANCE;
    testBed.initTestEnvironment(ngModule, platform, options);
    return testBed;
  }

  /**
   * Reset the providers for the test injector.
   *
   * 重置测试注入器的提供者。
   *
   * @publicApi
   */
  static resetTestEnvironment(): void {
    TestBedImpl.INSTANCE.resetTestEnvironment();
  }

  static configureCompiler(config: {providers?: any[]; useJit?: boolean;}): TestBed {
    return TestBedImpl.INSTANCE.configureCompiler(config);
  }

  /**
   * Allows overriding default providers, directives, pipes, modules of the test injector,
   * which are defined in test_injector.js
   *
   * 允许覆盖测试注入器的默认提供程序、指令、管道、模块，它们在 test_injector.js 中定义
   *
   */
  static configureTestingModule(moduleDef: TestModuleMetadata): TestBed {
    return TestBedImpl.INSTANCE.configureTestingModule(moduleDef);
  }

  /**
   * Compile components with a `templateUrl` for the test's NgModule.
   * It is necessary to call this function
   * as fetching urls is asynchronous.
   *
   * 使用 `templateUrl` Url 为测试的 NgModule 编译组件。有必要调用此函数，因为获取 url 是异步的。
   *
   */
  static compileComponents(): Promise<any> {
    return TestBedImpl.INSTANCE.compileComponents();
  }

  static overrideModule(ngModule: Type<any>, override: MetadataOverride<NgModule>): TestBed {
    return TestBedImpl.INSTANCE.overrideModule(ngModule, override);
  }

  static overrideComponent(component: Type<any>, override: MetadataOverride<Component>): TestBed {
    return TestBedImpl.INSTANCE.overrideComponent(component, override);
  }

  static overrideDirective(directive: Type<any>, override: MetadataOverride<Directive>): TestBed {
    return TestBedImpl.INSTANCE.overrideDirective(directive, override);
  }

  static overridePipe(pipe: Type<any>, override: MetadataOverride<Pipe>): TestBed {
    return TestBedImpl.INSTANCE.overridePipe(pipe, override);
  }

  static overrideTemplate(component: Type<any>, template: string): TestBed {
    return TestBedImpl.INSTANCE.overrideTemplate(component, template);
  }

  /**
   * Overrides the template of the given component, compiling the template
   * in the context of the TestingModule.
   *
   * 覆盖给定组件的模板，在 TestingModule 的上下文中编译模板。
   *
   * Note: This works for JIT and AOTed components as well.
   *
   * 注意：这也适用于 JIT 和 AOTed 组件。
   *
   */
  static overrideTemplateUsingTestingModule(component: Type<any>, template: string): TestBed {
    return TestBedImpl.INSTANCE.overrideTemplateUsingTestingModule(component, template);
  }

  static overrideProvider(token: any, provider: {
    useFactory: Function,
    deps: any[],
  }): TestBed;
  static overrideProvider(token: any, provider: {useValue: any;}): TestBed;
  static overrideProvider(token: any, provider: {
    useFactory?: Function,
    useValue?: any,
    deps?: any[],
  }): TestBed {
    return TestBedImpl.INSTANCE.overrideProvider(token, provider);
  }

  static inject<T>(token: ProviderToken<T>, notFoundValue: undefined, options: InjectOptions&{
    optional?: false
  }): T;
  static inject<T>(token: ProviderToken<T>, notFoundValue: null|undefined, options: InjectOptions):
      T|null;
  static inject<T>(token: ProviderToken<T>, notFoundValue?: T, options?: InjectOptions): T;
  /**
   * @deprecated
   *
   * use object-based flags (`InjectOptions`) instead.
   *
   * 改用基于对象的标志 ( `InjectOptions` ) 。
   *
   */
  static inject<T>(token: ProviderToken<T>, notFoundValue?: T, flags?: InjectFlags): T;
  /**
   * @deprecated
   *
   * use object-based flags (`InjectOptions`) instead.
   *
   * 改用基于对象的标志 ( `InjectOptions` ) 。
   *
   */
  static inject<T>(token: ProviderToken<T>, notFoundValue: null, flags?: InjectFlags): T|null;
  static inject<T>(
      token: ProviderToken<T>, notFoundValue?: T|null, flags?: InjectFlags|InjectOptions): T|null {
    return TestBedImpl.INSTANCE.inject(token, notFoundValue, convertToBitFlags(flags));
  }

  /**
   * @deprecated
   *
   * from v9.0.0 use TestBed.inject
   *
   * 从 v9.0.0 使用 TestBed.inject
   *
   */
  static get<T>(token: ProviderToken<T>, notFoundValue?: T, flags?: InjectFlags): any;
  /**
   * @deprecated
   *
   * from v9.0.0 use TestBed.inject
   *
   * 从 v9.0.0 使用 TestBed.inject
   *
   */
  static get(token: any, notFoundValue?: any): any;
  /**
   * @deprecated
   *
   * from v9.0.0 use TestBed.inject
   *
   * 从 v9.0.0 使用 TestBed.inject
   *
   */
  static get(
      token: any, notFoundValue: any = Injector.THROW_IF_NOT_FOUND,
      flags: InjectFlags = InjectFlags.Default): any {
    return TestBedImpl.INSTANCE.inject(token, notFoundValue, flags);
  }

  static createComponent<T>(component: Type<T>): ComponentFixture<T> {
    return TestBedImpl.INSTANCE.createComponent(component);
  }

  static resetTestingModule(): TestBed {
    return TestBedImpl.INSTANCE.resetTestingModule();
  }

  static execute(tokens: any[], fn: Function, context?: any): any {
    return TestBedImpl.INSTANCE.execute(tokens, fn, context);
  }

  static get platform(): PlatformRef {
    return TestBedImpl.INSTANCE.platform;
  }

  static get ngModule(): Type<any>|Type<any>[] {
    return TestBedImpl.INSTANCE.ngModule;
  }

  // Properties

  platform: PlatformRef = null!;
  ngModule: Type<any>|Type<any>[] = null!;

  private _compiler: TestBedCompiler|null = null;
  private _testModuleRef: NgModuleRef<any>|null = null;

  private _activeFixtures: ComponentFixture<any>[] = [];

  /**
   * Internal-only flag to indicate whether a module
   * scoping queue has been checked and flushed already.
   *
   * 仅供内部使用的标志，以表明模块作用域队列是否已被检查并刷新。
   *
   * @nodoc
   */
  globalCompilationChecked = false;

  /**
   * Initialize the environment for testing with a compiler factory, a PlatformRef, and an
   * angular module. These are common to every test in the suite.
   *
   * 使用编译器工厂、PlatformRef 和 Angular 模块初始化用于测试的环境。这些在套件中的每个测试中都是通用的。
   *
   * This may only be called once, to set up the common providers for the current test
   * suite on the current platform. If you absolutely need to change the providers,
   * first use `resetTestEnvironment`.
   *
   * 这可能只会调用一次，以在当前平台上为当前测试套件设置通用提供者。如果你绝对需要更改提供者，请首先使用 `resetTestEnvironment` 。
   *
   * Test modules and platforms for individual platforms are available from
   * '@angular/&lt;platform_name>/testing'.
   *
   * 单个平台的测试模块和平台可从 '@angular/&lt;platform_name>/testing' 获得。
   *
   * @publicApi
   */
  initTestEnvironment(
      ngModule: Type<any>|Type<any>[], platform: PlatformRef,
      options?: TestEnvironmentOptions): void {
    if (this.platform || this.ngModule) {
      throw new Error('Cannot set base providers because it has already been called');
    }

    TestBedImpl._environmentTeardownOptions = options?.teardown;

    TestBedImpl._environmentErrorOnUnknownElementsOption = options?.errorOnUnknownElements;

    TestBedImpl._environmentErrorOnUnknownPropertiesOption = options?.errorOnUnknownProperties;

    this.platform = platform;
    this.ngModule = ngModule;
    this._compiler = new TestBedCompiler(this.platform, this.ngModule);

    // TestBed does not have an API which can reliably detect the start of a test, and thus could be
    // used to track the state of the NgModule registry and reset it correctly. Instead, when we
    // know we're in a testing scenario, we disable the check for duplicate NgModule registration
    // completely.
    setAllowDuplicateNgModuleIdsForTest(true);
  }

  /**
   * Reset the providers for the test injector.
   *
   * 重置测试注入器的提供者。
   *
   * @publicApi
   */
  resetTestEnvironment(): void {
    this.resetTestingModule();
    this._compiler = null;
    this.platform = null!;
    this.ngModule = null!;
    TestBedImpl._environmentTeardownOptions = undefined;
    setAllowDuplicateNgModuleIdsForTest(false);
  }

  resetTestingModule(): this {
    this.checkGlobalCompilationFinished();
    resetCompiledComponents();
    if (this._compiler !== null) {
      this.compiler.restoreOriginalState();
    }
    this._compiler = new TestBedCompiler(this.platform, this.ngModule);
    // Restore the previous value of the "error on unknown elements" option
    setUnknownElementStrictMode(
        this._previousErrorOnUnknownElementsOption ?? THROW_ON_UNKNOWN_ELEMENTS_DEFAULT);
    // Restore the previous value of the "error on unknown properties" option
    setUnknownPropertyStrictMode(
        this._previousErrorOnUnknownPropertiesOption ?? THROW_ON_UNKNOWN_PROPERTIES_DEFAULT);

    // We have to chain a couple of try/finally blocks, because each step can
    // throw errors and we don't want it to interrupt the next step and we also
    // want an error to be thrown at the end.
    try {
      this.destroyActiveFixtures();
    } finally {
      try {
        if (this.shouldTearDownTestingModule()) {
          this.tearDownTestingModule();
        }
      } finally {
        this._testModuleRef = null;
        this._instanceTeardownOptions = undefined;
        this._instanceErrorOnUnknownElementsOption = undefined;
        this._instanceErrorOnUnknownPropertiesOption = undefined;
      }
    }
    return this;
  }

  configureCompiler(config: {providers?: any[]; useJit?: boolean;}): this {
    if (config.useJit != null) {
      throw new Error('the Render3 compiler JiT mode is not configurable !');
    }

    if (config.providers !== undefined) {
      this.compiler.setCompilerProviders(config.providers);
    }
    return this;
  }

  configureTestingModule(moduleDef: TestModuleMetadata): this {
    this.assertNotInstantiated('R3TestBed.configureTestingModule', 'configure the test module');

    // Trigger module scoping queue flush before executing other TestBed operations in a test.
    // This is needed for the first test invocation to ensure that globally declared modules have
    // their components scoped properly. See the `checkGlobalCompilationFinished` function
    // description for additional info.
    this.checkGlobalCompilationFinished();

    // Always re-assign the options, even if they're undefined.
    // This ensures that we don't carry them between tests.
    this._instanceTeardownOptions = moduleDef.teardown;
    this._instanceErrorOnUnknownElementsOption = moduleDef.errorOnUnknownElements;
    this._instanceErrorOnUnknownPropertiesOption = moduleDef.errorOnUnknownProperties;
    // Store the current value of the strict mode option,
    // so we can restore it later
    this._previousErrorOnUnknownElementsOption = getUnknownElementStrictMode();
    setUnknownElementStrictMode(this.shouldThrowErrorOnUnknownElements());
    this._previousErrorOnUnknownPropertiesOption = getUnknownPropertyStrictMode();
    setUnknownPropertyStrictMode(this.shouldThrowErrorOnUnknownProperties());
    this.compiler.configureTestingModule(moduleDef);
    return this;
  }

  compileComponents(): Promise<any> {
    return this.compiler.compileComponents();
  }

  inject<T>(token: ProviderToken<T>, notFoundValue: undefined, options: InjectOptions&{
    optional: true
  }): T|null;
  inject<T>(token: ProviderToken<T>, notFoundValue?: T, options?: InjectOptions): T;
  inject<T>(token: ProviderToken<T>, notFoundValue: null, options?: InjectOptions): T|null;
  /**
   * @deprecated
   *
   * use object-based flags (`InjectOptions`) instead.
   *
   * 改用基于对象的标志 ( `InjectOptions` ) 。
   *
   */
  inject<T>(token: ProviderToken<T>, notFoundValue?: T, flags?: InjectFlags): T;
  /**
   * @deprecated
   *
   * use object-based flags (`InjectOptions`) instead.
   *
   * 改用基于对象的标志 ( `InjectOptions` ) 。
   *
   */
  inject<T>(token: ProviderToken<T>, notFoundValue: null, flags?: InjectFlags): T|null;
  inject<T>(token: ProviderToken<T>, notFoundValue?: T|null, flags?: InjectFlags|InjectOptions): T
      |null {
    if (token as unknown === TestBed) {
      return this as any;
    }
    const UNDEFINED = {} as unknown as T;
    const result = this.testModuleRef.injector.get(token, UNDEFINED, convertToBitFlags(flags));
    return result === UNDEFINED ? this.compiler.injector.get(token, notFoundValue, flags) as any :
                                  result;
  }

  /**
   * @deprecated
   *
   * from v9.0.0 use TestBed.inject
   *
   * 从 v9.0.0 使用 TestBed.inject
   *
   */
  get<T>(token: ProviderToken<T>, notFoundValue?: T, flags?: InjectFlags): any;
  /**
   * @deprecated
   *
   * from v9.0.0 use TestBed.inject
   *
   * 从 v9.0.0 使用 TestBed.inject
   *
   */
  get(token: any, notFoundValue?: any): any;
  /**
   * @deprecated
   *
   * from v9.0.0 use TestBed.inject
   *
   * 从 v9.0.0 使用 TestBed.inject
   *
   */
  get(token: any, notFoundValue: any = Injector.THROW_IF_NOT_FOUND,
      flags: InjectFlags = InjectFlags.Default): any {
    return this.inject(token, notFoundValue, flags);
  }

  execute(tokens: any[], fn: Function, context?: any): any {
    const params = tokens.map(t => this.inject(t));
    return fn.apply(context, params);
  }

  overrideModule(ngModule: Type<any>, override: MetadataOverride<NgModule>): this {
    this.assertNotInstantiated('overrideModule', 'override module metadata');
    this.compiler.overrideModule(ngModule, override);
    return this;
  }

  overrideComponent(component: Type<any>, override: MetadataOverride<Component>): this {
    this.assertNotInstantiated('overrideComponent', 'override component metadata');
    this.compiler.overrideComponent(component, override);
    return this;
  }

  overrideTemplateUsingTestingModule(component: Type<any>, template: string): this {
    this.assertNotInstantiated(
        'R3TestBed.overrideTemplateUsingTestingModule',
        'Cannot override template when the test module has already been instantiated');
    this.compiler.overrideTemplateUsingTestingModule(component, template);
    return this;
  }

  overrideDirective(directive: Type<any>, override: MetadataOverride<Directive>): this {
    this.assertNotInstantiated('overrideDirective', 'override directive metadata');
    this.compiler.overrideDirective(directive, override);
    return this;
  }

  overridePipe(pipe: Type<any>, override: MetadataOverride<Pipe>): this {
    this.assertNotInstantiated('overridePipe', 'override pipe metadata');
    this.compiler.overridePipe(pipe, override);
    return this;
  }

  /**
   * Overwrites all providers for the given token with the given provider definition.
   *
   * 使用给定的提供程序定义覆盖给定标记的所有提供程序。
   *
   */
  overrideProvider(token: any, provider: {useFactory?: Function, useValue?: any, deps?: any[]}):
      this {
    this.assertNotInstantiated('overrideProvider', 'override provider');
    this.compiler.overrideProvider(token, provider);
    return this;
  }

  overrideTemplate(component: Type<any>, template: string): TestBed {
    return this.overrideComponent(component, {set: {template, templateUrl: null!}});
  }

  createComponent<T>(type: Type<T>): ComponentFixture<T> {
    const testComponentRenderer = this.inject(TestComponentRenderer);
    const rootElId = `root${_nextRootElementId++}`;
    testComponentRenderer.insertRootElement(rootElId);

    const componentDef = (type as any).ɵcmp;

    if (!componentDef) {
      throw new Error(`It looks like '${stringify(type)}' has not been compiled.`);
    }

    // TODO: Don't cast as `InjectionToken<boolean>`, proper type is boolean[]
    const noNgZone = this.inject(ComponentFixtureNoNgZone as InjectionToken<boolean>, false);
    // TODO: Don't cast as `InjectionToken<boolean>`, proper type is boolean[]
    const autoDetect: boolean =
        this.inject(ComponentFixtureAutoDetect as InjectionToken<boolean>, false);
    const ngZone: NgZone|null = noNgZone ? null : this.inject(NgZone, null);
    const componentFactory = new ComponentFactory(componentDef);
    const initComponent = () => {
      const componentRef =
          componentFactory.create(Injector.NULL, [], `#${rootElId}`, this.testModuleRef);
      return new ComponentFixture<any>(componentRef, ngZone, autoDetect);
    };
    const fixture = ngZone ? ngZone.run(initComponent) : initComponent();
    this._activeFixtures.push(fixture);
    return fixture;
  }

  /**
   * @internal strip this from published d.ts files due to
   * https://github.com/microsoft/TypeScript/issues/36216
   */
  private get compiler(): TestBedCompiler {
    if (this._compiler === null) {
      throw new Error(`Need to call TestBed.initTestEnvironment() first`);
    }
    return this._compiler;
  }

  /**
   * @internal strip this from published d.ts files due to
   * https://github.com/microsoft/TypeScript/issues/36216
   */
  private get testModuleRef(): NgModuleRef<any> {
    if (this._testModuleRef === null) {
      this._testModuleRef = this.compiler.finalize();
    }
    return this._testModuleRef;
  }

  private assertNotInstantiated(methodName: string, methodDescription: string) {
    if (this._testModuleRef !== null) {
      throw new Error(
          `Cannot ${methodDescription} when the test module has already been instantiated. ` +
          `Make sure you are not using \`inject\` before \`${methodName}\`.`);
    }
  }

  /**
   * Check whether the module scoping queue should be flushed, and flush it if needed.
   *
   * 检查是否应该刷新模块范围队列，并在需要时刷新它。
   *
   * When the TestBed is reset, it clears the JIT module compilation queue, cancelling any
   * in-progress module compilation. This creates a potential hazard - the very first time the
   * TestBed is initialized (or if it's reset without being initialized), there may be pending
   * compilations of modules declared in global scope. These compilations should be finished.
   *
   * 当 TestBed 重置时，它会清除 JIT 模块编译队列，从而取消任何正在进行的模块编译。这会产生潜在的危险 - 第一次初始化 TestBed 时（或者如果它在未初始化的情况下被重置），可能会有在全局范围内声明的模块的挂起编译。这些编译应该已经完成。
   *
   * To ensure that globally declared modules have their components scoped properly, this function
   * is called whenever TestBed is initialized or reset. The _first_ time that this happens, prior
   * to any other operations, the scoping queue is flushed.
   *
   * 为了确保全局声明的模块的组件范围正确，每当 TestBed 初始化或重置时都会调用此函数。_ 第 _ 一次发生这种情况时，在任何其他操作之前，作用域队列会被刷新。
   *
   */
  private checkGlobalCompilationFinished(): void {
    // Checking _testNgModuleRef is null should not be necessary, but is left in as an additional
    // guard that compilations queued in tests (after instantiation) are never flushed accidentally.
    if (!this.globalCompilationChecked && this._testModuleRef === null) {
      flushModuleScopingQueueAsMuchAsPossible();
    }
    this.globalCompilationChecked = true;
  }

  private destroyActiveFixtures(): void {
    let errorCount = 0;
    this._activeFixtures.forEach((fixture) => {
      try {
        fixture.destroy();
      } catch (e) {
        errorCount++;
        console.error('Error during cleanup of component', {
          component: fixture.componentInstance,
          stacktrace: e,
        });
      }
    });
    this._activeFixtures = [];

    if (errorCount > 0 && this.shouldRethrowTeardownErrors()) {
      throw Error(
          `${errorCount} ${(errorCount === 1 ? 'component' : 'components')} ` +
          `threw errors during cleanup`);
    }
  }

  shouldRethrowTeardownErrors(): boolean {
    const instanceOptions = this._instanceTeardownOptions;
    const environmentOptions = TestBedImpl._environmentTeardownOptions;

    // If the new teardown behavior hasn't been configured, preserve the old behavior.
    if (!instanceOptions && !environmentOptions) {
      return TEARDOWN_TESTING_MODULE_ON_DESTROY_DEFAULT;
    }

    // Otherwise use the configured behavior or default to rethrowing.
    return instanceOptions?.rethrowErrors ?? environmentOptions?.rethrowErrors ??
        this.shouldTearDownTestingModule();
  }

  shouldThrowErrorOnUnknownElements(): boolean {
    // Check if a configuration has been provided to throw when an unknown element is found
    return this._instanceErrorOnUnknownElementsOption ??
        TestBedImpl._environmentErrorOnUnknownElementsOption ?? THROW_ON_UNKNOWN_ELEMENTS_DEFAULT;
  }

  shouldThrowErrorOnUnknownProperties(): boolean {
    // Check if a configuration has been provided to throw when an unknown property is found
    return this._instanceErrorOnUnknownPropertiesOption ??
        TestBedImpl._environmentErrorOnUnknownPropertiesOption ??
        THROW_ON_UNKNOWN_PROPERTIES_DEFAULT;
  }

  shouldTearDownTestingModule(): boolean {
    return this._instanceTeardownOptions?.destroyAfterEach ??
        TestBedImpl._environmentTeardownOptions?.destroyAfterEach ??
        TEARDOWN_TESTING_MODULE_ON_DESTROY_DEFAULT;
  }

  tearDownTestingModule() {
    // If the module ref has already been destroyed, we won't be able to get a test renderer.
    if (this._testModuleRef === null) {
      return;
    }
    // Resolve the renderer ahead of time, because we want to remove the root elements as the very
    // last step, but the injector will be destroyed as a part of the module ref destruction.
    const testRenderer = this.inject(TestComponentRenderer);
    try {
      this._testModuleRef.destroy();
    } catch (e) {
      if (this.shouldRethrowTeardownErrors()) {
        throw e;
      } else {
        console.error('Error during cleanup of a testing module', {
          component: this._testModuleRef.instance,
          stacktrace: e,
        });
      }
    } finally {
      testRenderer.removeAllRootElements?.();
    }
  }
}

/**
 * @description
 *
 * Configures and initializes environment for unit testing and provides methods for
 * creating components and services in unit tests.
 *
 * 配置和初始化用于单元测试的环境，并提供用于在单元测试中创建组件和服务的方法。
 *
 * `TestBed` is the primary api for writing unit tests for Angular applications and libraries.
 *
 * `TestBed` 是为 Angular 应用程序和库编写单元测试的主要 api。
 *
 * @publicApi
 */
export const TestBed: TestBedStatic = TestBedImpl;

/**
 * Allows injecting dependencies in `beforeEach()` and `it()`. Note: this function
 * (imported from the `@angular/core/testing` package) can **only** be used to inject dependencies
 * in tests. To inject dependencies in your application code, use the [`inject`](api/core/inject)
 * function from the `@angular/core` package instead.
 *
 * 允许在 `beforeEach()` 和 `it()` 中注入依赖项。
 *
 * Example:
 *
 * 比如：
 *
 * ```
 * beforeEach(inject([Dependency, AClass], (dep, object) => {
 *   // some code that uses `dep` and `object`
 *   // ...
 * }));
 *
 * it('...', inject([AClass], (object) => {
 *   object.doSomething();
 *   expect(...);
 * })
 * ```
 *
 * @publicApi
 */
export function inject(tokens: any[], fn: Function): () => any {
  const testBed = TestBedImpl.INSTANCE;
  // Not using an arrow function to preserve context passed from call site
  return function(this: unknown) {
    return testBed.execute(tokens, fn, this);
  };
}

/**
 * @publicApi
 */
export class InjectSetupWrapper {
  constructor(private _moduleDef: () => TestModuleMetadata) {}

  private _addModule() {
    const moduleDef = this._moduleDef();
    if (moduleDef) {
      TestBedImpl.configureTestingModule(moduleDef);
    }
  }

  inject(tokens: any[], fn: Function): () => any {
    const self = this;
    // Not using an arrow function to preserve context passed from call site
    return function(this: unknown) {
      self._addModule();
      return inject(tokens, fn).call(this);
    };
  }
}

/**
 * @publicApi
 */
export function withModule(moduleDef: TestModuleMetadata): InjectSetupWrapper;
export function withModule(moduleDef: TestModuleMetadata, fn: Function): () => any;
export function withModule(moduleDef: TestModuleMetadata, fn?: Function|null): (() => any)|
    InjectSetupWrapper {
  if (fn) {
    // Not using an arrow function to preserve context passed from call site
    return function(this: unknown) {
      const testBed = TestBedImpl.INSTANCE;
      if (moduleDef) {
        testBed.configureTestingModule(moduleDef);
      }
      return fn.apply(this);
    };
  }
  return new InjectSetupWrapper(() => moduleDef);
}
