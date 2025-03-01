/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

/*
 * This file exists to support compilation of @angular/core in Ivy mode.
 *
 * When the Angular compiler processes a compilation unit, it normally writes imports to
 * @angular/core. When compiling the core package itself this strategy isn't usable. Instead, the
 * compiler writes imports to this file.
 *
 * Only a subset of such imports are supported - core is not allowed to declare components or pipes.
 * A check in ngtsc's `R3SymbolsImportRewriter` validates this condition. The rewriter is only used
 * when compiling @angular/core and is responsible for translating an external name (prefixed with
 * ɵ) to the internal symbol name as exported below.
 *
 * The below symbols are used for @Injectable and @NgModule compilation.
 */

export {ɵɵinject} from './di/injector_compatibility';
export {ɵɵdefineInjectable, ɵɵdefineInjector, ɵɵInjectableDeclaration} from './di/interface/defs';
export {NgModuleDef} from './metadata/ng_module_def';
export {ɵɵdefineNgModule} from './render3/definition';
export {ɵɵFactoryDeclaration, ɵɵInjectorDeclaration, ɵɵNgModuleDeclaration} from './render3/interfaces/public_definitions';
export {setClassMetadata} from './render3/metadata';
export {NgModuleFactory} from './render3/ng_module_ref';
export {noSideEffects as ɵnoSideEffects} from './util/closure';



/**
 * The existence of this constant (in this particular file) informs the Angular compiler that the
 * current program is actually @angular/core, which needs to be compiled specially.
 *
 * 这个常量（在这个特定文件中）的存在告诉 Angular 编译器当前程序实际上是 @angular/core
 * ，需要特殊编译。
 *
 */
export const ITS_JUST_ANGULAR = true;
