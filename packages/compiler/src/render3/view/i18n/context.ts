/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {AST} from '../../../expression_parser/ast';
import * as i18n from '../../../i18n/i18n_ast';
import * as o from '../../../output/output_ast';

import {assembleBoundTextPlaceholders, getSeqNumberGenerator, updatePlaceholderMap, wrapI18nPlaceholder} from './util';

enum TagType {
  ELEMENT,
  TEMPLATE,
}

/**
 * Generates an object that is used as a shared state between parent and all child contexts.
 *
 * 生成一个对象，用作父上下文和所有子上下文之间的共享状态。
 *
 */
function setupRegistry() {
  return {getUniqueId: getSeqNumberGenerator(), icus: new Map<string, any[]>()};
}

/**
 * I18nContext is a helper class which keeps track of all i18n-related aspects
 * (accumulates placeholders, bindings, etc) between i18nStart and i18nEnd instructions.
 *
 * I18nContext 是一个帮助器类，它会跟踪 i18nStart 和 i18nEnd 指令之间的所有 i18n
 * 相关切面（累积占位符、绑定等）。
 *
 * When we enter a nested template, the top-level context is being passed down
 * to the nested component, which uses this context to generate a child instance
 * of I18nContext class (to handle nested template) and at the end, reconciles it back
 * with the parent context.
 *
 * 当我们输入嵌套模板时，顶级上下文正在被传递给嵌套组件，它使用此上下文生成 I18nContext
 * 类的子实例（以处理嵌套模板），并最后将其与父级协调上下文。
 *
 * @param index Instruction index of i18nStart, which initiates this context
 *
 * i18nStart 的指令索引，用于启动此上下文
 *
 * @param ref Reference to a translation const that represents the content if thus context
 *
 * 对表示内容的翻译 const 的引用，如果是上下文
 *
 * @param level Nesting level defined for child contexts
 *
 * 为子上下文定义的嵌套级别
 *
 * @param templateIndex Instruction index of a template which this context belongs to
 *
 * 此上下文所属的模板的指令索引
 *
 * @param meta Meta information (id, meaning, description, etc) associated with this context
 *
 * 与此上下文相关的元信息（id、含义、描述等）
 *
 */
export class I18nContext {
  public readonly id: number;
  public bindings = new Set<AST>();
  public placeholders = new Map<string, any[]>();
  public isEmitted: boolean = false;

  private _registry!: any;
  private _unresolvedCtxCount: number = 0;

  constructor(
      readonly index: number, readonly ref: o.ReadVarExpr, readonly level: number = 0,
      readonly templateIndex: number|null = null, readonly meta: i18n.I18nMeta,
      private registry?: any) {
    this._registry = registry || setupRegistry();
    this.id = this._registry.getUniqueId();
  }

  private appendTag(type: TagType, node: i18n.TagPlaceholder, index: number, closed?: boolean) {
    if (node.isVoid && closed) {
      return;  // ignore "close" for void tags
    }
    const ph = node.isVoid || !closed ? node.startName : node.closeName;
    const content = {type, index, ctx: this.id, isVoid: node.isVoid, closed};
    updatePlaceholderMap(this.placeholders, ph, content);
  }

  get icus() {
    return this._registry.icus;
  }
  get isRoot() {
    return this.level === 0;
  }
  get isResolved() {
    return this._unresolvedCtxCount === 0;
  }

  getSerializedPlaceholders() {
    const result = new Map<string, any[]>();
    this.placeholders.forEach(
        (values, key) => result.set(key, values.map(serializePlaceholderValue)));
    return result;
  }

  // public API to accumulate i18n-related content
  appendBinding(binding: AST) {
    this.bindings.add(binding);
  }
  appendIcu(name: string, ref: o.Expression) {
    updatePlaceholderMap(this._registry.icus, name, ref);
  }
  appendBoundText(node: i18n.I18nMeta) {
    const phs = assembleBoundTextPlaceholders(node, this.bindings.size, this.id);
    phs.forEach((values, key) => updatePlaceholderMap(this.placeholders, key, ...values));
  }
  appendTemplate(node: i18n.I18nMeta, index: number) {
    // add open and close tags at the same time,
    // since we process nested templates separately
    this.appendTag(TagType.TEMPLATE, node as i18n.TagPlaceholder, index, false);
    this.appendTag(TagType.TEMPLATE, node as i18n.TagPlaceholder, index, true);
    this._unresolvedCtxCount++;
  }
  appendElement(node: i18n.I18nMeta, index: number, closed?: boolean) {
    this.appendTag(TagType.ELEMENT, node as i18n.TagPlaceholder, index, closed);
  }
  appendProjection(node: i18n.I18nMeta, index: number) {
    // Add open and close tags at the same time, since `<ng-content>` has no content,
    // so when we come across `<ng-content>` we can register both open and close tags.
    // Note: runtime i18n logic doesn't distinguish `<ng-content>` tag placeholders and
    // regular element tag placeholders, so we generate element placeholders for both types.
    this.appendTag(TagType.ELEMENT, node as i18n.TagPlaceholder, index, false);
    this.appendTag(TagType.ELEMENT, node as i18n.TagPlaceholder, index, true);
  }

  /**
   * Generates an instance of a child context based on the root one,
   * when we enter a nested template within I18n section.
   *
   * 当我们在 I18n 部分中输入嵌套模板时，会根据根上下文生成子上下文的实例。
   *
   * @param index Instruction index of corresponding i18nStart, which initiates this context
   *
   * 启动此上下文的相应 i18nStart 的指令索引
   *
   * @param templateIndex Instruction index of a template which this context belongs to
   *
   * 此上下文所属的模板的指令索引
   *
   * @param meta Meta information (id, meaning, description, etc) associated with this context
   *
   * 与此上下文相关的元信息（id、含义、描述等）
   *
   * @returns
   *
   * I18nContext instance
   *
   * I18nContext 实例
   *
   */
  forkChildContext(index: number, templateIndex: number, meta: i18n.I18nMeta) {
    return new I18nContext(index, this.ref, this.level + 1, templateIndex, meta, this._registry);
  }

  /**
   * Reconciles child context into parent one once the end of the i18n block is reached (i18nEnd).
   *
   * 到达 i18n 块的末尾 (i18nEnd) 后，将子上下文协调为父上下文。
   *
   * @param context Child I18nContext instance to be reconciled with parent context.
   *
   * 要与父上下文协调的子 I18nContext 实例。
   *
   */
  reconcileChildContext(context: I18nContext) {
    // set the right context id for open and close
    // template tags, so we can use it as sub-block ids
    ['start', 'close'].forEach((op: string) => {
      const key = (context.meta as any)[`${op}Name`];
      const phs = this.placeholders.get(key) || [];
      const tag = phs.find(findTemplateFn(this.id, context.templateIndex));
      if (tag) {
        tag.ctx = context.id;
      }
    });

    // reconcile placeholders
    const childPhs = context.placeholders;
    childPhs.forEach((values: any[], key: string) => {
      const phs = this.placeholders.get(key);
      if (!phs) {
        this.placeholders.set(key, values);
        return;
      }
      // try to find matching template...
      const tmplIdx = phs.findIndex(findTemplateFn(context.id, context.templateIndex));
      if (tmplIdx >= 0) {
        // ... if found - replace it with nested template content
        const isCloseTag = key.startsWith('CLOSE');
        const isTemplateTag = key.endsWith('NG-TEMPLATE');
        if (isTemplateTag) {
          // current template's content is placed before or after
          // parent template tag, depending on the open/close attribute
          phs.splice(tmplIdx + (isCloseTag ? 0 : 1), 0, ...values);
        } else {
          const idx = isCloseTag ? values.length - 1 : 0;
          values[idx].tmpl = phs[tmplIdx];
          phs.splice(tmplIdx, 1, ...values);
        }
      } else {
        // ... otherwise just append content to placeholder value
        phs.push(...values);
      }
      this.placeholders.set(key, phs);
    });
    this._unresolvedCtxCount--;
  }
}

//
// Helper methods
//

function wrap(symbol: string, index: number, contextId: number, closed?: boolean): string {
  const state = closed ? '/' : '';
  return wrapI18nPlaceholder(`${state}${symbol}${index}`, contextId);
}

function wrapTag(symbol: string, {index, ctx, isVoid}: any, closed?: boolean): string {
  return isVoid ? wrap(symbol, index, ctx) + wrap(symbol, index, ctx, true) :
                  wrap(symbol, index, ctx, closed);
}

function findTemplateFn(ctx: number, templateIndex: number|null) {
  return (token: any) => typeof token === 'object' && token.type === TagType.TEMPLATE &&
      token.index === templateIndex && token.ctx === ctx;
}

function serializePlaceholderValue(value: any): string {
  const element = (data: any, closed?: boolean) => wrapTag('#', data, closed);
  const template = (data: any, closed?: boolean) => wrapTag('*', data, closed);
  const projection = (data: any, closed?: boolean) => wrapTag('!', data, closed);

  switch (value.type) {
    case TagType.ELEMENT:
      // close element tag
      if (value.closed) {
        return element(value, true) + (value.tmpl ? template(value.tmpl, true) : '');
      }
      // open element tag that also initiates a template
      if (value.tmpl) {
        return template(value.tmpl) + element(value) +
            (value.isVoid ? template(value.tmpl, true) : '');
      }
      return element(value);

    case TagType.TEMPLATE:
      return template(value, value.closed);

    default:
      return value;
  }
}
