/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import ts from 'typescript';

import {Reference} from '../../imports';
import {FunctionDefinition} from '../../reflection';

import {SyntheticValue} from './synthetic';

/**
 * The reason why a value cannot be determined statically.
 *
 * 无法静态确定值的原因。
 *
 */
export const enum DynamicValueReason {
  /**
   * A value could not be determined statically, because it contains a term that could not be
   * determined statically.
   * (E.g. a property assignment or call expression where the lhs is a `DynamicValue`, a template
   * literal with a dynamic expression, an object literal with a spread assignment which could not
   * be determined statically, etc.)
   *
   * 无法静态确定一个值，因为它包含一个无法静态确定的术语。（例如，lhs 是 `DynamicValue`
   * 的属性赋值或调用表达式、具有动态表达式的模板文字、具有无法静态确定的扩展赋值的对象文字等）
   *
   */
  DYNAMIC_INPUT,

  /**
   * A string could not be statically evaluated.
   * (E.g. a dynamically constructed object property name or a template literal expression that
   * could not be statically resolved to a primitive value.)
   *
   * 无法静态估算字符串。（例如，动态构造的对象属性名称或无法静态解析为原始值的模板文字表达式。）
   *
   */
  DYNAMIC_STRING,

  /**
   * An external reference could not be resolved to a value which can be evaluated.
   * For example a call expression for a function declared in `.d.ts`, or accessing native globals
   * such as `window`.
   *
   * 外部引用无法解析为可以估算的值。例如，在 `.d.ts`
   * 中声明的函数的调用表达式，或访问本机全局变量，例如 `window` 。
   *
   */
  EXTERNAL_REFERENCE,

  /**
   * Syntax that `StaticInterpreter` doesn't know how to evaluate, for example a type of
   * `ts.Expression` that is not supported.
   *
   * `StaticInterpreter` 不知道如何估算的语法，例如不支持的 `ts.Expression` 类型。
   *
   */
  UNSUPPORTED_SYNTAX,

  /**
   * A declaration of a `ts.Identifier` could not be found.
   *
   * `ts.Identifier` 的声明。
   *
   */
  UNKNOWN_IDENTIFIER,

  /**
   * A value could be resolved, but is not an acceptable type for the operation being performed.
   *
   * 可以解析一个值，但不是正在执行的操作可接受的类型。
   *
   * For example, attempting to call a non-callable expression.
   *
   * 例如，尝试调用不可调用的表达式。
   *
   */
  INVALID_EXPRESSION_TYPE,

  /**
   * A function call could not be evaluated as the function's body is not a single return statement.
   *
   * 无法估算函数调用，因为函数的主体不是单个 return 语句。
   *
   */
  COMPLEX_FUNCTION_CALL,

  /**
   * A value that could not be determined because it contains type information that cannot be
   * statically evaluated. This happens when producing a value from type information, but the value
   * of the given type cannot be determined statically.
   *
   * 无法确定的值，因为它包含无法静态估算的类型信息。从类型信息生成值时会发生这种情况，但给定类型的值无法静态确定。
   *
   * E.g. evaluating a tuple.
   *
   * 例如，估算一个元组。
   *
   *   `declare const foo: [string];`
   *
   *  Evaluating `foo` gives a DynamicValue wrapped in an array with a reason of DYNAMIC_TYPE. This
   * is because the static evaluator has a `string` type for the first element of this tuple, and
   * the value of that string cannot be determined statically. The type `string` permits it to be
   * 'foo', 'bar' or any arbitrary string, so we evaluate it to a DynamicValue.
   *
   * 估算 `foo` 会给出一个包装在数组中的 DynamicValue，其原因为 DYNAMIC_TYPE
   * 。这是因为静态估算器对此元组的第一个元素具有 `string` 类型，并且该字符串的值无法静态确定。
   * `string` 类型允许它是 'foo'、'bar' 或任何任意字符串，因此我们将其估算为 DynamicValue。
   *
   */
  DYNAMIC_TYPE,

  /**
   * A value could not be determined because one of the inputs to its evaluation is a synthetically
   * produced value.
   *
   * 无法确定一个值，因为其估算的输入之一是综合生成的值。
   *
   */
  SYNTHETIC_INPUT,

  /**
   * A value could not be determined statically for any reason other the above.
   *
   * 由于上述之外的任何原因，无法静态确定一个值。
   *
   */
  UNKNOWN,
}

/**
 * Represents a value which cannot be determined statically.
 *
 * 表示一个无法静态确定的值。
 *
 */
export class DynamicValue<R = unknown> {
  private constructor(
      readonly node: ts.Node, readonly reason: R, private code: DynamicValueReason) {}

  static fromDynamicInput(node: ts.Node, input: DynamicValue): DynamicValue<DynamicValue> {
    return new DynamicValue(node, input, DynamicValueReason.DYNAMIC_INPUT);
  }

  static fromDynamicString(node: ts.Node): DynamicValue {
    return new DynamicValue(node, undefined, DynamicValueReason.DYNAMIC_STRING);
  }

  static fromExternalReference(node: ts.Node, ref: Reference<ts.Declaration>):
      DynamicValue<Reference<ts.Declaration>> {
    return new DynamicValue(node, ref, DynamicValueReason.EXTERNAL_REFERENCE);
  }

  static fromUnsupportedSyntax(node: ts.Node): DynamicValue {
    return new DynamicValue(node, undefined, DynamicValueReason.UNSUPPORTED_SYNTAX);
  }

  static fromUnknownIdentifier(node: ts.Identifier): DynamicValue {
    return new DynamicValue(node, undefined, DynamicValueReason.UNKNOWN_IDENTIFIER);
  }

  static fromInvalidExpressionType(node: ts.Node, value: unknown): DynamicValue<unknown> {
    return new DynamicValue(node, value, DynamicValueReason.INVALID_EXPRESSION_TYPE);
  }

  static fromComplexFunctionCall(node: ts.Node, fn: FunctionDefinition):
      DynamicValue<FunctionDefinition> {
    return new DynamicValue(node, fn, DynamicValueReason.COMPLEX_FUNCTION_CALL);
  }

  static fromDynamicType(node: ts.TypeNode): DynamicValue {
    return new DynamicValue(node, undefined, DynamicValueReason.DYNAMIC_TYPE);
  }

  static fromSyntheticInput(node: ts.Node, value: SyntheticValue<unknown>):
      DynamicValue<SyntheticValue<unknown>> {
    return new DynamicValue(node, value, DynamicValueReason.SYNTHETIC_INPUT);
  }

  static fromUnknown(node: ts.Node): DynamicValue {
    return new DynamicValue(node, undefined, DynamicValueReason.UNKNOWN);
  }

  isFromDynamicInput(this: DynamicValue<R>): this is DynamicValue<DynamicValue> {
    return this.code === DynamicValueReason.DYNAMIC_INPUT;
  }

  isFromDynamicString(this: DynamicValue<R>): this is DynamicValue {
    return this.code === DynamicValueReason.DYNAMIC_STRING;
  }

  isFromExternalReference(this: DynamicValue<R>): this is DynamicValue<Reference<ts.Declaration>> {
    return this.code === DynamicValueReason.EXTERNAL_REFERENCE;
  }

  isFromUnsupportedSyntax(this: DynamicValue<R>): this is DynamicValue {
    return this.code === DynamicValueReason.UNSUPPORTED_SYNTAX;
  }

  isFromUnknownIdentifier(this: DynamicValue<R>): this is DynamicValue {
    return this.code === DynamicValueReason.UNKNOWN_IDENTIFIER;
  }

  isFromInvalidExpressionType(this: DynamicValue<R>): this is DynamicValue<unknown> {
    return this.code === DynamicValueReason.INVALID_EXPRESSION_TYPE;
  }

  isFromComplexFunctionCall(this: DynamicValue<R>): this is DynamicValue<FunctionDefinition> {
    return this.code === DynamicValueReason.COMPLEX_FUNCTION_CALL;
  }

  isFromDynamicType(this: DynamicValue<R>): this is DynamicValue {
    return this.code === DynamicValueReason.DYNAMIC_TYPE;
  }

  isFromUnknown(this: DynamicValue<R>): this is DynamicValue {
    return this.code === DynamicValueReason.UNKNOWN;
  }

  accept<R>(visitor: DynamicValueVisitor<R>): R {
    switch (this.code) {
      case DynamicValueReason.DYNAMIC_INPUT:
        return visitor.visitDynamicInput(this as unknown as DynamicValue<DynamicValue>);
      case DynamicValueReason.DYNAMIC_STRING:
        return visitor.visitDynamicString(this);
      case DynamicValueReason.EXTERNAL_REFERENCE:
        return visitor.visitExternalReference(
            this as unknown as DynamicValue<Reference<ts.Declaration>>);
      case DynamicValueReason.UNSUPPORTED_SYNTAX:
        return visitor.visitUnsupportedSyntax(this);
      case DynamicValueReason.UNKNOWN_IDENTIFIER:
        return visitor.visitUnknownIdentifier(this);
      case DynamicValueReason.INVALID_EXPRESSION_TYPE:
        return visitor.visitInvalidExpressionType(this);
      case DynamicValueReason.COMPLEX_FUNCTION_CALL:
        return visitor.visitComplexFunctionCall(
            this as unknown as DynamicValue<FunctionDefinition>);
      case DynamicValueReason.DYNAMIC_TYPE:
        return visitor.visitDynamicType(this);
      case DynamicValueReason.SYNTHETIC_INPUT:
        return visitor.visitSyntheticInput(
            this as unknown as DynamicValue<SyntheticValue<unknown>>);
      case DynamicValueReason.UNKNOWN:
        return visitor.visitUnknown(this);
    }
  }
}

export interface DynamicValueVisitor<R> {
  visitDynamicInput(value: DynamicValue<DynamicValue>): R;
  visitDynamicString(value: DynamicValue): R;
  visitExternalReference(value: DynamicValue<Reference<ts.Declaration>>): R;
  visitUnsupportedSyntax(value: DynamicValue): R;
  visitUnknownIdentifier(value: DynamicValue): R;
  visitInvalidExpressionType(value: DynamicValue): R;
  visitComplexFunctionCall(value: DynamicValue<FunctionDefinition>): R;
  visitDynamicType(value: DynamicValue): R;
  visitSyntheticInput(value: DynamicValue<SyntheticValue<unknown>>): R;
  visitUnknown(value: DynamicValue): R;
}
