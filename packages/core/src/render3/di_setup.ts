/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */


import {resolveForwardRef} from '../di/forward_ref';
import {ClassProvider, Provider} from '../di/interface/provider';
import {isClassProvider, isTypeProvider} from '../di/provider_collection';
import {providerToFactory} from '../di/r3_injector';
import {assertDefined} from '../util/assert';

import {diPublicInInjector, getNodeInjectable, getOrCreateNodeInjectorForNode} from './di';
import {ɵɵdirectiveInject} from './instructions/all';
import {DirectiveDef} from './interfaces/definition';
import {NodeInjectorFactory} from './interfaces/injector';
import {TContainerNode, TDirectiveHostNode, TElementContainerNode, TElementNode, TNodeProviderIndexes} from './interfaces/node';
import {isComponentDef} from './interfaces/type_checks';
import {DestroyHookData, LView, TData, TVIEW, TView} from './interfaces/view';
import {getCurrentTNode, getLView, getTView} from './state';



/**
 * Resolves the providers which are defined in the DirectiveDef.
 *
 * 解析 DirectiveDef 中定义的提供者。
 *
 * When inserting the tokens and the factories in their respective arrays, we can assume that
 * this method is called first for the component (if any), and then for other directives on the same
 * node.
 * As a consequence,the providers are always processed in that order:
 * 1) The view providers of the component
 * 2) The providers of the component
 * 3) The providers of the other directives
 * This matches the structure of the injectables arrays of a view (for each node).
 * So the tokens and the factories can be pushed at the end of the arrays, except
 * in one case for multi providers.
 *
 * 在各自的数组中插入标记和工厂时，我们可以假定首先为组件（如果有）调用此方法，然后为同一个节点上的其他指令调用。因此，提供程序始终按该顺序处理：
 * 1）组件的视图提供者 2）组件的提供者 3）其他指令的提供者 这与视图的 injectionables
 * 数组的结构（每个节点）。因此，标记和工厂可以被推送到数组的末尾，但在一种情况下是多重提供者。
 *
 * @param def the directive definition
 *
 * 指令定义
 *
 * @param providers: Array of `providers`.
 * @param viewProviders: Array of `viewProviders`.
 */
export function providersResolver<T>(
    def: DirectiveDef<T>, providers: Provider[], viewProviders: Provider[]): void {
  const tView = getTView();
  if (tView.firstCreatePass) {
    const isComponent = isComponentDef(def);

    // The list of view providers is processed first, and the flags are updated
    resolveProvider(viewProviders, tView.data, tView.blueprint, isComponent, true);

    // Then, the list of providers is processed, and the flags are updated
    resolveProvider(providers, tView.data, tView.blueprint, isComponent, false);
  }
}

/**
 * Resolves a provider and publishes it to the DI system.
 *
 * 解析提供者并将其发布到 DI 系统。
 *
 */
function resolveProvider(
    provider: Provider, tInjectables: TData, lInjectablesBlueprint: NodeInjectorFactory[],
    isComponent: boolean, isViewProvider: boolean): void {
  provider = resolveForwardRef(provider);
  if (Array.isArray(provider)) {
    // Recursively call `resolveProvider`
    // Recursion is OK in this case because this code will not be in hot-path once we implement
    // cloning of the initial state.
    for (let i = 0; i < provider.length; i++) {
      resolveProvider(
          provider[i], tInjectables, lInjectablesBlueprint, isComponent, isViewProvider);
    }
  } else {
    const tView = getTView();
    const lView = getLView();
    let token: any = isTypeProvider(provider) ? provider : resolveForwardRef(provider.provide);
    let providerFactory: () => any = providerToFactory(provider);

    const tNode = getCurrentTNode()!;
    const beginIndex = tNode.providerIndexes & TNodeProviderIndexes.ProvidersStartIndexMask;
    const endIndex = tNode.directiveStart;
    const cptViewProvidersCount =
        tNode.providerIndexes >> TNodeProviderIndexes.CptViewProvidersCountShift;

    if (isTypeProvider(provider) || !provider.multi) {
      // Single provider case: the factory is created and pushed immediately
      const factory = new NodeInjectorFactory(providerFactory, isViewProvider, ɵɵdirectiveInject);
      const existingFactoryIndex = indexOf(
          token, tInjectables, isViewProvider ? beginIndex : beginIndex + cptViewProvidersCount,
          endIndex);
      if (existingFactoryIndex === -1) {
        diPublicInInjector(
            getOrCreateNodeInjectorForNode(
                tNode as TElementNode | TContainerNode | TElementContainerNode, lView),
            tView, token);
        registerDestroyHooksIfSupported(tView, provider, tInjectables.length);
        tInjectables.push(token);
        tNode.directiveStart++;
        tNode.directiveEnd++;
        if (isViewProvider) {
          tNode.providerIndexes += TNodeProviderIndexes.CptViewProvidersCountShifter;
        }
        lInjectablesBlueprint.push(factory);
        lView.push(factory);
      } else {
        lInjectablesBlueprint[existingFactoryIndex] = factory;
        lView[existingFactoryIndex] = factory;
      }
    } else {
      // Multi provider case:
      // We create a multi factory which is going to aggregate all the values.
      // Since the output of such a factory depends on content or view injection,
      // we create two of them, which are linked together.
      //
      // The first one (for view providers) is always in the first block of the injectables array,
      // and the second one (for providers) is always in the second block.
      // This is important because view providers have higher priority. When a multi token
      // is being looked up, the view providers should be found first.
      // Note that it is not possible to have a multi factory in the third block (directive block).
      //
      // The algorithm to process multi providers is as follows:
      // 1) If the multi provider comes from the `viewProviders` of the component:
      //   a) If the special view providers factory doesn't exist, it is created and pushed.
      //   b) Else, the multi provider is added to the existing multi factory.
      // 2) If the multi provider comes from the `providers` of the component or of another
      // directive:
      //   a) If the multi factory doesn't exist, it is created and provider pushed into it.
      //      It is also linked to the multi factory for view providers, if it exists.
      //   b) Else, the multi provider is added to the existing multi factory.

      const existingProvidersFactoryIndex =
          indexOf(token, tInjectables, beginIndex + cptViewProvidersCount, endIndex);
      const existingViewProvidersFactoryIndex =
          indexOf(token, tInjectables, beginIndex, beginIndex + cptViewProvidersCount);
      const doesProvidersFactoryExist = existingProvidersFactoryIndex >= 0 &&
          lInjectablesBlueprint[existingProvidersFactoryIndex];
      const doesViewProvidersFactoryExist = existingViewProvidersFactoryIndex >= 0 &&
          lInjectablesBlueprint[existingViewProvidersFactoryIndex];

      if (isViewProvider && !doesViewProvidersFactoryExist ||
          !isViewProvider && !doesProvidersFactoryExist) {
        // Cases 1.a and 2.a
        diPublicInInjector(
            getOrCreateNodeInjectorForNode(
                tNode as TElementNode | TContainerNode | TElementContainerNode, lView),
            tView, token);
        const factory = multiFactory(
            isViewProvider ? multiViewProvidersFactoryResolver : multiProvidersFactoryResolver,
            lInjectablesBlueprint.length, isViewProvider, isComponent, providerFactory);
        if (!isViewProvider && doesViewProvidersFactoryExist) {
          lInjectablesBlueprint[existingViewProvidersFactoryIndex].providerFactory = factory;
        }
        registerDestroyHooksIfSupported(tView, provider, tInjectables.length, 0);
        tInjectables.push(token);
        tNode.directiveStart++;
        tNode.directiveEnd++;
        if (isViewProvider) {
          tNode.providerIndexes += TNodeProviderIndexes.CptViewProvidersCountShifter;
        }
        lInjectablesBlueprint.push(factory);
        lView.push(factory);
      } else {
        // Cases 1.b and 2.b
        const indexInFactory = multiFactoryAdd(
            lInjectablesBlueprint!
                [isViewProvider ? existingViewProvidersFactoryIndex :
                                  existingProvidersFactoryIndex],
            providerFactory, !isViewProvider && isComponent);
        registerDestroyHooksIfSupported(
            tView, provider,
            existingProvidersFactoryIndex > -1 ? existingProvidersFactoryIndex :
                                                 existingViewProvidersFactoryIndex,
            indexInFactory);
      }
      if (!isViewProvider && isComponent && doesViewProvidersFactoryExist) {
        lInjectablesBlueprint[existingViewProvidersFactoryIndex].componentProviders!++;
      }
    }
  }
}

/**
 * Registers the `ngOnDestroy` hook of a provider, if the provider supports destroy hooks.
 *
 * 如果提供者支持 destroy 钩子，则注册提供者的 `ngOnDestroy` 钩子。
 *
 * @param tView `TView` in which to register the hook.
 *
 * 要在其中注册钩子的 `TView` 。
 *
 * @param provider Provider whose hook should be registered.
 *
 * 应该注册其钩子的提供者。
 *
 * @param contextIndex Index under which to find the context for the hook when it's being invoked.
 *
 * 调用钩子时要在其下查找钩子上下文的索引。
 *
 * @param indexInFactory Only required for `multi` providers. Index of the provider in the multi
 * provider factory.
 *
 * 仅 `multi` 提供程序需要。多提供者工厂中提供者的索引。
 *
 */
function registerDestroyHooksIfSupported(
    tView: TView, provider: Exclude<Provider, any[]>, contextIndex: number,
    indexInFactory?: number) {
  const providerIsTypeProvider = isTypeProvider(provider);
  const providerIsClassProvider = isClassProvider(provider);

  if (providerIsTypeProvider || providerIsClassProvider) {
    // Resolve forward references as `useClass` can hold a forward reference.
    const classToken = providerIsClassProvider ? resolveForwardRef(provider.useClass) : provider;
    const prototype = classToken.prototype;
    const ngOnDestroy = prototype.ngOnDestroy;

    if (ngOnDestroy) {
      const hooks = tView.destroyHooks || (tView.destroyHooks = []);

      if (!providerIsTypeProvider && ((provider as ClassProvider)).multi) {
        ngDevMode &&
            assertDefined(
                indexInFactory, 'indexInFactory when registering multi factory destroy hook');
        const existingCallbacksIndex = hooks.indexOf(contextIndex);

        if (existingCallbacksIndex === -1) {
          hooks.push(contextIndex, [indexInFactory, ngOnDestroy]);
        } else {
          (hooks[existingCallbacksIndex + 1] as DestroyHookData).push(indexInFactory!, ngOnDestroy);
        }
      } else {
        hooks.push(contextIndex, ngOnDestroy);
      }
    }
  }
}

/**
 * Add a factory in a multi factory.
 *
 * 在多工厂中添加工厂。
 *
 * @returns
 *
 * Index at which the factory was inserted.
 *
 * 插入工厂的索引。
 *
 */
function multiFactoryAdd(
    multiFactory: NodeInjectorFactory, factory: () => any, isComponentProvider: boolean): number {
  if (isComponentProvider) {
    multiFactory.componentProviders!++;
  }
  return multiFactory.multi!.push(factory) - 1;
}

/**
 * Returns the index of item in the array, but only in the begin to end range.
 *
 * 返回数组中条目的索引，但仅在开始到结束范围内。
 *
 */
function indexOf(item: any, arr: any[], begin: number, end: number) {
  for (let i = begin; i < end; i++) {
    if (arr[i] === item) return i;
  }
  return -1;
}

/**
 * Use this with `multi` `providers`.
 *
 * 将其与 `multi` `providers` 一起使用。
 *
 */
function multiProvidersFactoryResolver(
    this: NodeInjectorFactory, _: undefined, tData: TData, lData: LView,
    tNode: TDirectiveHostNode): any[] {
  return multiResolve(this.multi!, []);
}

/**
 * Use this with `multi` `viewProviders`.
 *
 * 将其与 `multi` `viewProviders` 一起使用。
 *
 * This factory knows how to concatenate itself with the existing `multi` `providers`.
 *
 * 该工厂知道如何将自己与现有的 `multi` `providers` 连接起来。
 *
 */
function multiViewProvidersFactoryResolver(
    this: NodeInjectorFactory, _: undefined, tData: TData, lView: LView,
    tNode: TDirectiveHostNode): any[] {
  const factories = this.multi!;
  let result: any[];
  if (this.providerFactory) {
    const componentCount = this.providerFactory.componentProviders!;
    const multiProviders =
        getNodeInjectable(lView, lView[TVIEW], this.providerFactory!.index!, tNode);
    // Copy the section of the array which contains `multi` `providers` from the component
    result = multiProviders.slice(0, componentCount);
    // Insert the `viewProvider` instances.
    multiResolve(factories, result);
    // Copy the section of the array which contains `multi` `providers` from other directives
    for (let i = componentCount; i < multiProviders.length; i++) {
      result.push(multiProviders[i]);
    }
  } else {
    result = [];
    // Insert the `viewProvider` instances.
    multiResolve(factories, result);
  }
  return result;
}

/**
 * Maps an array of factories into an array of values.
 *
 * 将工厂数组映射到值数组。
 *
 */
function multiResolve(factories: Array<() => any>, result: any[]): any[] {
  for (let i = 0; i < factories.length; i++) {
    const factory = factories[i]! as () => null;
    result.push(factory());
  }
  return result;
}

/**
 * Creates a multi factory.
 *
 * 创建多工厂。
 *
 */
function multiFactory(
    factoryFn: (
        this: NodeInjectorFactory, _: undefined, tData: TData, lData: LView,
        tNode: TDirectiveHostNode) => any,
    index: number, isViewProvider: boolean, isComponent: boolean,
    f: () => any): NodeInjectorFactory {
  const factory = new NodeInjectorFactory(factoryFn, isViewProvider, ɵɵdirectiveInject);
  factory.multi = [];
  factory.index = index;
  factory.componentProviders = 0;
  multiFactoryAdd(factory, f, isComponent && !isViewProvider);
  return factory;
}
