/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */


import {assertIndexInRange} from '../../util/assert';
import {isObservable} from '../../util/lang';
import {PropertyAliasValue, TNode, TNodeType} from '../interfaces/node';
import {GlobalTargetResolver, Renderer} from '../interfaces/renderer';
import {RElement} from '../interfaces/renderer_dom';
import {isDirectiveHost} from '../interfaces/type_checks';
import {CLEANUP, CONTEXT, LView, RENDERER, TView} from '../interfaces/view';
import {assertTNodeType} from '../node_assert';
import {profiler, ProfilerEvent} from '../profiler';
import {getCurrentDirectiveDef, getCurrentTNode, getLView, getTView} from '../state';
import {getComponentLViewByIndex, getNativeByTNode, unwrapRNode} from '../util/view_utils';

import {getOrCreateLViewCleanup, getOrCreateTViewCleanup, handleError, loadComponentRenderer, markViewDirty} from './shared';



/**
 * Adds an event listener to the current node.
 *
 * 向当前节点添加事件侦听器。
 *
 * If an output exists on one of the node's directives, it also subscribes to the output
 * and saves the subscription for later cleanup.
 *
 * 如果节点的指令之一存在输出，它还会订阅输出并保存订阅以供以后清理。
 *
 * @param eventName Name of the event
 *
 * 事件名称
 *
 * @param listenerFn The function to be called when event emits
 * @param useCapture Whether or not to use capture in event listener - this argument is a reminder
 *     from the Renderer3 infrastructure and should be removed from the instruction arguments
 * @param eventTargetResolver Function that returns global target information in case this listener
 * should be attached to a global object like window, document or body
 *
 * 返回全局目标信息的函数，以防此侦听器应该附加到全局对象，例如窗口、文档或正文
 *
 * @codeGenApi
 */
export function ɵɵlistener(
    eventName: string, listenerFn: (e?: any) => any, useCapture?: boolean,
    eventTargetResolver?: GlobalTargetResolver): typeof ɵɵlistener {
  const lView = getLView<{}|null>();
  const tView = getTView();
  const tNode = getCurrentTNode()!;
  listenerInternal(
      tView, lView, lView[RENDERER], tNode, eventName, listenerFn, eventTargetResolver);
  return ɵɵlistener;
}

/**
 * Registers a synthetic host listener (e.g. `(@foo.start)`) on a component or directive.
 *
 * 在组件或指令上注册合成宿主侦听器（例如 `(@foo.start)`）。
 *
 * This instruction is for compatibility purposes and is designed to ensure that a
 * synthetic host listener (e.g. `@HostListener('@foo.start')`) properly gets rendered
 * in the component's renderer. Normally all host listeners are evaluated with the
 * parent component's renderer, but, in the case of animation @triggers, they need
 * to be evaluated with the sub component's renderer (because that's where the
 * animation triggers are defined).
 *
 * 本操作指南是出于兼容性目的，旨在确保合成宿主侦听器（例如 `@HostListener('@foo.start')`
 *）在组件的渲染器中正确呈现。通常，所有宿主侦听器都使用父组件的渲染器进行估算，但是，对于动画 @triggers
 * ，它们需要使用子组件的渲染器进行估算（因为这是定义动画触发器的地方）。
 *
 * Do not use this instruction as a replacement for `listener`. This instruction
 * only exists to ensure compatibility with the ViewEngine's host binding behavior.
 *
 * 不要使用此指令作为 `listener` 的替代。本操作指南的存在只是为了确保与 ViewEngine
 * 的宿主绑定行为兼容。
 *
 * @param eventName Name of the event
 *
 * 事件名称
 *
 * @param listenerFn The function to be called when event emits
 *
 * 事件发出时要调用的函数
 *
 * @param useCapture Whether or not to use capture in event listener
 *
 * 是否在事件侦听器中使用捕获
 *
 * @param eventTargetResolver Function that returns global target information in case this listener
 * should be attached to a global object like window, document or body
 *
 * 返回全局目标信息的函数，以防此侦听器应该附加到全局对象，例如窗口、文档或正文
 *
 * @codeGenApi
 */
export function ɵɵsyntheticHostListener(
    eventName: string, listenerFn: (e?: any) => any): typeof ɵɵsyntheticHostListener {
  const tNode = getCurrentTNode()!;
  const lView = getLView<{}|null>();
  const tView = getTView();
  const currentDef = getCurrentDirectiveDef(tView.data);
  const renderer = loadComponentRenderer(currentDef, tNode, lView);
  listenerInternal(tView, lView, renderer, tNode, eventName, listenerFn);
  return ɵɵsyntheticHostListener;
}

/**
 * A utility function that checks if a given element has already an event handler registered for an
 * event with a specified name. The TView.cleanup data structure is used to find out which events
 * are registered for a given element.
 *
 * 一种工具函数，它会检查给定元素是否已经为具有指定名称的事件注册了事件处理程序。 TView.cleanup
 * 数据结构用于找出为给定元素注册的事件。
 *
 */
function findExistingListener(
    tView: TView, lView: LView, eventName: string, tNodeIdx: number): ((e?: any) => any)|null {
  const tCleanup = tView.cleanup;
  if (tCleanup != null) {
    for (let i = 0; i < tCleanup.length - 1; i += 2) {
      const cleanupEventName = tCleanup[i];
      if (cleanupEventName === eventName && tCleanup[i + 1] === tNodeIdx) {
        // We have found a matching event name on the same node but it might not have been
        // registered yet, so we must explicitly verify entries in the LView cleanup data
        // structures.
        const lCleanup = lView[CLEANUP]!;
        const listenerIdxInLCleanup = tCleanup[i + 2];
        return lCleanup.length > listenerIdxInLCleanup ? lCleanup[listenerIdxInLCleanup] : null;
      }
      // TView.cleanup can have a mix of 4-elements entries (for event handler cleanups) or
      // 2-element entries (for directive and queries destroy hooks). As such we can encounter
      // blocks of 4 or 2 items in the tView.cleanup and this is why we iterate over 2 elements
      // first and jump another 2 elements if we detect listeners cleanup (4 elements). Also check
      // documentation of TView.cleanup for more details of this data structure layout.
      if (typeof cleanupEventName === 'string') {
        i += 2;
      }
    }
  }
  return null;
}

function listenerInternal(
    tView: TView, lView: LView<{}|null>, renderer: Renderer, tNode: TNode, eventName: string,
    listenerFn: (e?: any) => any, eventTargetResolver?: GlobalTargetResolver): void {
  const isTNodeDirectiveHost = isDirectiveHost(tNode);
  const firstCreatePass = tView.firstCreatePass;
  const tCleanup: false|any[] = firstCreatePass && getOrCreateTViewCleanup(tView);
  const context = lView[CONTEXT];

  // When the ɵɵlistener instruction was generated and is executed we know that there is either a
  // native listener or a directive output on this element. As such we we know that we will have to
  // register a listener and store its cleanup function on LView.
  const lCleanup = getOrCreateLViewCleanup(lView);

  ngDevMode && assertTNodeType(tNode, TNodeType.AnyRNode | TNodeType.AnyContainer);

  let processOutputs = true;

  // Adding a native event listener is applicable when:
  // - The corresponding TNode represents a DOM element.
  // - The event target has a resolver (usually resulting in a global object,
  //   such as `window` or `document`).
  if ((tNode.type & TNodeType.AnyRNode) || eventTargetResolver) {
    const native = getNativeByTNode(tNode, lView) as RElement;
    const target = eventTargetResolver ? eventTargetResolver(native) : native;
    const lCleanupIndex = lCleanup.length;
    const idxOrTargetGetter = eventTargetResolver ?
        (_lView: LView) => eventTargetResolver(unwrapRNode(_lView[tNode.index])) :
        tNode.index;

    // In order to match current behavior, native DOM event listeners must be added for all
    // events (including outputs).

    // There might be cases where multiple directives on the same element try to register an event
    // handler function for the same event. In this situation we want to avoid registration of
    // several native listeners as each registration would be intercepted by NgZone and
    // trigger change detection. This would mean that a single user action would result in several
    // change detections being invoked. To avoid this situation we want to have only one call to
    // native handler registration (for the same element and same type of event).
    //
    // In order to have just one native event handler in presence of multiple handler functions,
    // we just register a first handler function as a native event listener and then chain
    // (coalesce) other handler functions on top of the first native handler function.
    let existingListener = null;
    // Please note that the coalescing described here doesn't happen for events specifying an
    // alternative target (ex. (document:click)) - this is to keep backward compatibility with the
    // view engine.
    // Also, we don't have to search for existing listeners is there are no directives
    // matching on a given node as we can't register multiple event handlers for the same event in
    // a template (this would mean having duplicate attributes).
    if (!eventTargetResolver && isTNodeDirectiveHost) {
      existingListener = findExistingListener(tView, lView, eventName, tNode.index);
    }
    if (existingListener !== null) {
      // Attach a new listener to coalesced listeners list, maintaining the order in which
      // listeners are registered. For performance reasons, we keep a reference to the last
      // listener in that list (in `__ngLastListenerFn__` field), so we can avoid going through
      // the entire set each time we need to add a new listener.
      const lastListenerFn = (<any>existingListener).__ngLastListenerFn__ || existingListener;
      lastListenerFn.__ngNextListenerFn__ = listenerFn;
      (<any>existingListener).__ngLastListenerFn__ = listenerFn;
      processOutputs = false;
    } else {
      listenerFn = wrapListener(tNode, lView, context, listenerFn, false /** preventDefault */);
      const cleanupFn = renderer.listen(target as RElement, eventName, listenerFn);
      ngDevMode && ngDevMode.rendererAddEventListener++;

      lCleanup.push(listenerFn, cleanupFn);
      tCleanup && tCleanup.push(eventName, idxOrTargetGetter, lCleanupIndex, lCleanupIndex + 1);
    }

  } else {
    // Even if there is no native listener to add, we still need to wrap the listener so that OnPush
    // ancestors are marked dirty when an event occurs.
    listenerFn = wrapListener(tNode, lView, context, listenerFn, false /** preventDefault */);
  }

  // subscribe to directive outputs
  const outputs = tNode.outputs;
  let props: PropertyAliasValue|undefined;
  if (processOutputs && outputs !== null && (props = outputs[eventName])) {
    const propsLength = props.length;
    if (propsLength) {
      for (let i = 0; i < propsLength; i += 2) {
        const index = props[i] as number;
        ngDevMode && assertIndexInRange(lView, index);
        const minifiedName = props[i + 1];
        const directiveInstance = lView[index];
        const output = directiveInstance[minifiedName];

        if (ngDevMode && !isObservable(output)) {
          throw new Error(`@Output ${minifiedName} not initialized in '${
              directiveInstance.constructor.name}'.`);
        }

        const subscription = output.subscribe(listenerFn);
        const idx = lCleanup.length;
        lCleanup.push(listenerFn, subscription);
        tCleanup && tCleanup.push(eventName, tNode.index, idx, -(idx + 1));
      }
    }
  }
}

function executeListenerWithErrorHandling(
    lView: LView, context: {}|null, listenerFn: (e?: any) => any, e: any): boolean {
  try {
    profiler(ProfilerEvent.OutputStart, context, listenerFn);
    // Only explicitly returning false from a listener should preventDefault
    return listenerFn(e) !== false;
  } catch (error) {
    handleError(lView, error);
    return false;
  } finally {
    profiler(ProfilerEvent.OutputEnd, context, listenerFn);
  }
}

/**
 * Wraps an event listener with a function that marks ancestors dirty and prevents default behavior,
 * if applicable.
 *
 * 使用将祖先标记为脏并防止默认行为的函数包装事件侦听器（如果适用）。
 *
 * @param tNode The TNode associated with this listener
 *
 * 与此侦听器关联的 TNode
 *
 * @param lView The LView that contains this listener
 *
 * 包含此侦听器的 LView
 *
 * @param listenerFn The listener function to call
 *
 * 要调用的侦听器函数
 *
 * @param wrapWithPreventDefault Whether or not to prevent default behavior
 * (the procedural renderer does this already, so in those cases, we should skip)
 *
 * 是否防止默认行为（程序渲染器已经这样做了，因此在这些情况下，我们应该跳过）
 *
 */
function wrapListener(
    tNode: TNode, lView: LView<{}|null>, context: {}|null, listenerFn: (e?: any) => any,
    wrapWithPreventDefault: boolean): EventListener {
  // Note: we are performing most of the work in the listener function itself
  // to optimize listener registration.
  return function wrapListenerIn_markDirtyAndPreventDefault(e: any) {
    // Ivy uses `Function` as a special token that allows us to unwrap the function
    // so that it can be invoked programmatically by `DebugNode.triggerEventHandler`.
    if (e === Function) {
      return listenerFn;
    }

    // In order to be backwards compatible with View Engine, events on component host nodes
    // must also mark the component view itself dirty (i.e. the view that it owns).
    const startView =
        tNode.componentOffset > -1 ? getComponentLViewByIndex(tNode.index, lView) : lView;
    markViewDirty(startView);

    let result = executeListenerWithErrorHandling(lView, context, listenerFn, e);
    // A just-invoked listener function might have coalesced listeners so we need to check for
    // their presence and invoke as needed.
    let nextListenerFn = (<any>wrapListenerIn_markDirtyAndPreventDefault).__ngNextListenerFn__;
    while (nextListenerFn) {
      // We should prevent default if any of the listeners explicitly return false
      result = executeListenerWithErrorHandling(lView, context, nextListenerFn, e) && result;
      nextListenerFn = (<any>nextListenerFn).__ngNextListenerFn__;
    }

    if (wrapWithPreventDefault && result === false) {
      e.preventDefault();
      // Necessary for legacy browsers that don't support preventDefault (e.g. IE)
      e.returnValue = false;
    }

    return result;
  };
}
