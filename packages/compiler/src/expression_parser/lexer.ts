/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import * as chars from '../chars';

export enum TokenType {
  Character,
  Identifier,
  PrivateIdentifier,
  Keyword,
  String,
  Operator,
  Number,
  Error
}

const KEYWORDS = ['var', 'let', 'as', 'null', 'undefined', 'true', 'false', 'if', 'else', 'this'];

export class Lexer {
  tokenize(text: string): Token[] {
    const scanner = new _Scanner(text);
    const tokens: Token[] = [];
    let token = scanner.scanToken();
    while (token != null) {
      tokens.push(token);
      token = scanner.scanToken();
    }
    return tokens;
  }
}

export class Token {
  constructor(
      public index: number, public end: number, public type: TokenType, public numValue: number,
      public strValue: string) {}

  isCharacter(code: number): boolean {
    return this.type == TokenType.Character && this.numValue == code;
  }

  isNumber(): boolean {
    return this.type == TokenType.Number;
  }

  isString(): boolean {
    return this.type == TokenType.String;
  }

  isOperator(operator: string): boolean {
    return this.type == TokenType.Operator && this.strValue == operator;
  }

  isIdentifier(): boolean {
    return this.type == TokenType.Identifier;
  }

  isPrivateIdentifier(): boolean {
    return this.type == TokenType.PrivateIdentifier;
  }

  isKeyword(): boolean {
    return this.type == TokenType.Keyword;
  }

  isKeywordLet(): boolean {
    return this.type == TokenType.Keyword && this.strValue == 'let';
  }

  isKeywordAs(): boolean {
    return this.type == TokenType.Keyword && this.strValue == 'as';
  }

  isKeywordNull(): boolean {
    return this.type == TokenType.Keyword && this.strValue == 'null';
  }

  isKeywordUndefined(): boolean {
    return this.type == TokenType.Keyword && this.strValue == 'undefined';
  }

  isKeywordTrue(): boolean {
    return this.type == TokenType.Keyword && this.strValue == 'true';
  }

  isKeywordFalse(): boolean {
    return this.type == TokenType.Keyword && this.strValue == 'false';
  }

  isKeywordThis(): boolean {
    return this.type == TokenType.Keyword && this.strValue == 'this';
  }

  isError(): boolean {
    return this.type == TokenType.Error;
  }

  toNumber(): number {
    return this.type == TokenType.Number ? this.numValue : -1;
  }

  toString(): string|null {
    switch (this.type) {
      case TokenType.Character:
      case TokenType.Identifier:
      case TokenType.Keyword:
      case TokenType.Operator:
      case TokenType.PrivateIdentifier:
      case TokenType.String:
      case TokenType.Error:
        return this.strValue;
      case TokenType.Number:
        return this.numValue.toString();
      default:
        return null;
    }
  }
}

function newCharacterToken(index: number, end: number, code: number): Token {
  return new Token(index, end, TokenType.Character, code, String.fromCharCode(code));
}

function newIdentifierToken(index: number, end: number, text: string): Token {
  return new Token(index, end, TokenType.Identifier, 0, text);
}

function newPrivateIdentifierToken(index: number, end: number, text: string): Token {
  return new Token(index, end, TokenType.PrivateIdentifier, 0, text);
}

function newKeywordToken(index: number, end: number, text: string): Token {
  return new Token(index, end, TokenType.Keyword, 0, text);
}

function newOperatorToken(index: number, end: number, text: string): Token {
  return new Token(index, end, TokenType.Operator, 0, text);
}

function newStringToken(index: number, end: number, text: string): Token {
  return new Token(index, end, TokenType.String, 0, text);
}

function newNumberToken(index: number, end: number, n: number): Token {
  return new Token(index, end, TokenType.Number, n, '');
}

function newErrorToken(index: number, end: number, message: string): Token {
  return new Token(index, end, TokenType.Error, 0, message);
}

export const EOF: Token = new Token(-1, -1, TokenType.Character, 0, '');

class _Scanner {
  length: number;
  peek: number = 0;
  index: number = -1;

  constructor(public input: string) {
    this.length = input.length;
    this.advance();
  }

  advance() {
    this.peek = ++this.index >= this.length ? chars.$EOF : this.input.charCodeAt(this.index);
  }

  scanToken(): Token|null {
    const input = this.input, length = this.length;
    let peek = this.peek, index = this.index;

    // Skip whitespace.
    while (peek <= chars.$SPACE) {
      if (++index >= length) {
        peek = chars.$EOF;
        break;
      } else {
        peek = input.charCodeAt(index);
      }
    }

    this.peek = peek;
    this.index = index;

    if (index >= length) {
      return null;
    }

    // Handle identifiers and numbers.
    if (isIdentifierStart(peek)) return this.scanIdentifier();
    if (chars.isDigit(peek)) return this.scanNumber(index);

    const start: number = index;
    switch (peek) {
      case chars.$PERIOD:
        this.advance();
        return chars.isDigit(this.peek) ? this.scanNumber(start) :
                                          newCharacterToken(start, this.index, chars.$PERIOD);
      case chars.$LPAREN:
      case chars.$RPAREN:
      case chars.$LBRACE:
      case chars.$RBRACE:
      case chars.$LBRACKET:
      case chars.$RBRACKET:
      case chars.$COMMA:
      case chars.$COLON:
      case chars.$SEMICOLON:
        return this.scanCharacter(start, peek);
      case chars.$SQ:
      case chars.$DQ:
        return this.scanString();
      case chars.$HASH:
        return this.scanPrivateIdentifier();
      case chars.$PLUS:
      case chars.$MINUS:
      case chars.$STAR:
      case chars.$SLASH:
      case chars.$PERCENT:
      case chars.$CARET:
        return this.scanOperator(start, String.fromCharCode(peek));
      case chars.$QUESTION:
        return this.scanQuestion(start);
      case chars.$LT:
      case chars.$GT:
        return this.scanComplexOperator(start, String.fromCharCode(peek), chars.$EQ, '=');
      case chars.$BANG:
      case chars.$EQ:
        return this.scanComplexOperator(
            start, String.fromCharCode(peek), chars.$EQ, '=', chars.$EQ, '=');
      case chars.$AMPERSAND:
        return this.scanComplexOperator(start, '&', chars.$AMPERSAND, '&');
      case chars.$BAR:
        return this.scanComplexOperator(start, '|', chars.$BAR, '|');
      case chars.$NBSP:
        while (chars.isWhitespace(this.peek)) this.advance();
        return this.scanToken();
    }

    this.advance();
    return this.error(`Unexpected character [${String.fromCharCode(peek)}]`, 0);
  }

  scanCharacter(start: number, code: number): Token {
    this.advance();
    return newCharacterToken(start, this.index, code);
  }


  scanOperator(start: number, str: string): Token {
    this.advance();
    return newOperatorToken(start, this.index, str);
  }

  /**
   * Tokenize a 2/3 char long operator
   *
   * 标记 2/3 字符长的运算符
   *
   * @param start start index in the expression
   *
   * 表达式中的开始索引
   *
   * @param one first symbol (always part of the operator)
   *
   * 第一个符号（始终是运算符的一部分）
   *
   * @param twoCode code point for the second symbol
   *
   * 第二个符号的代码点
   *
   * @param two second symbol (part of the operator when the second code point matches)
   *
   * 第二个符号（第二个代码点匹配时的运算符的一部分）
   *
   * @param threeCode code point for the third symbol
   *
   * 第三个符号的代码点
   *
   * @param three third symbol (part of the operator when provided and matches source expression)
   *
   * 第三个符号（提供时是运算符的一部分并与源表达式匹配）
   *
   */
  scanComplexOperator(
      start: number, one: string, twoCode: number, two: string, threeCode?: number,
      three?: string): Token {
    this.advance();
    let str: string = one;
    if (this.peek == twoCode) {
      this.advance();
      str += two;
    }
    if (threeCode != null && this.peek == threeCode) {
      this.advance();
      str += three;
    }
    return newOperatorToken(start, this.index, str);
  }

  scanIdentifier(): Token {
    const start: number = this.index;
    this.advance();
    while (isIdentifierPart(this.peek)) this.advance();
    const str: string = this.input.substring(start, this.index);
    return KEYWORDS.indexOf(str) > -1 ? newKeywordToken(start, this.index, str) :
                                        newIdentifierToken(start, this.index, str);
  }

  /**
   * Scans an ECMAScript private identifier.
   *
   * 扫描 ECMAScript 私有标识符。
   *
   */
  scanPrivateIdentifier(): Token {
    const start: number = this.index;
    this.advance();
    if (!isIdentifierStart(this.peek)) {
      return this.error('Invalid character [#]', -1);
    }
    while (isIdentifierPart(this.peek)) this.advance();
    const identifierName: string = this.input.substring(start, this.index);
    return newPrivateIdentifierToken(start, this.index, identifierName);
  }

  scanNumber(start: number): Token {
    let simple = (this.index === start);
    let hasSeparators = false;
    this.advance();  // Skip initial digit.
    while (true) {
      if (chars.isDigit(this.peek)) {
        // Do nothing.
      } else if (this.peek === chars.$_) {
        // Separators are only valid when they're surrounded by digits. E.g. `1_0_1` is
        // valid while `_101` and `101_` are not. The separator can't be next to the decimal
        // point or another separator either. Note that it's unlikely that we'll hit a case where
        // the underscore is at the start, because that's a valid identifier and it will be picked
        // up earlier in the parsing. We validate for it anyway just in case.
        if (!chars.isDigit(this.input.charCodeAt(this.index - 1)) ||
            !chars.isDigit(this.input.charCodeAt(this.index + 1))) {
          return this.error('Invalid numeric separator', 0);
        }
        hasSeparators = true;
      } else if (this.peek === chars.$PERIOD) {
        simple = false;
      } else if (isExponentStart(this.peek)) {
        this.advance();
        if (isExponentSign(this.peek)) this.advance();
        if (!chars.isDigit(this.peek)) return this.error('Invalid exponent', -1);
        simple = false;
      } else {
        break;
      }
      this.advance();
    }

    let str = this.input.substring(start, this.index);
    if (hasSeparators) {
      str = str.replace(/_/g, '');
    }
    const value = simple ? parseIntAutoRadix(str) : parseFloat(str);
    return newNumberToken(start, this.index, value);
  }

  scanString(): Token {
    const start: number = this.index;
    const quote: number = this.peek;
    this.advance();  // Skip initial quote.

    let buffer: string = '';
    let marker: number = this.index;
    const input: string = this.input;

    while (this.peek != quote) {
      if (this.peek == chars.$BACKSLASH) {
        buffer += input.substring(marker, this.index);
        this.advance();
        let unescapedCode: number;
        // Workaround for TS2.1-introduced type strictness
        this.peek = this.peek;
        if (this.peek == chars.$u) {
          // 4 character hex code for unicode character.
          const hex: string = input.substring(this.index + 1, this.index + 5);
          if (/^[0-9a-f]+$/i.test(hex)) {
            unescapedCode = parseInt(hex, 16);
          } else {
            return this.error(`Invalid unicode escape [\\u${hex}]`, 0);
          }
          for (let i: number = 0; i < 5; i++) {
            this.advance();
          }
        } else {
          unescapedCode = unescape(this.peek);
          this.advance();
        }
        buffer += String.fromCharCode(unescapedCode);
        marker = this.index;
      } else if (this.peek == chars.$EOF) {
        return this.error('Unterminated quote', 0);
      } else {
        this.advance();
      }
    }

    const last: string = input.substring(marker, this.index);
    this.advance();  // Skip terminating quote.

    return newStringToken(start, this.index, buffer + last);
  }

  scanQuestion(start: number): Token {
    this.advance();
    let str: string = '?';
    // Either `a ?? b` or 'a?.b'.
    if (this.peek === chars.$QUESTION || this.peek === chars.$PERIOD) {
      str += this.peek === chars.$PERIOD ? '.' : '?';
      this.advance();
    }
    return newOperatorToken(start, this.index, str);
  }

  error(message: string, offset: number): Token {
    const position: number = this.index + offset;
    return newErrorToken(
        position, this.index,
        `Lexer Error: ${message} at column ${position} in expression [${this.input}]`);
  }
}

function isIdentifierStart(code: number): boolean {
  return (chars.$a <= code && code <= chars.$z) || (chars.$A <= code && code <= chars.$Z) ||
      (code == chars.$_) || (code == chars.$$);
}

export function isIdentifier(input: string): boolean {
  if (input.length == 0) return false;
  const scanner = new _Scanner(input);
  if (!isIdentifierStart(scanner.peek)) return false;
  scanner.advance();
  while (scanner.peek !== chars.$EOF) {
    if (!isIdentifierPart(scanner.peek)) return false;
    scanner.advance();
  }
  return true;
}

function isIdentifierPart(code: number): boolean {
  return chars.isAsciiLetter(code) || chars.isDigit(code) || (code == chars.$_) ||
      (code == chars.$$);
}

function isExponentStart(code: number): boolean {
  return code == chars.$e || code == chars.$E;
}

function isExponentSign(code: number): boolean {
  return code == chars.$MINUS || code == chars.$PLUS;
}

function unescape(code: number): number {
  switch (code) {
    case chars.$n:
      return chars.$LF;
    case chars.$f:
      return chars.$FF;
    case chars.$r:
      return chars.$CR;
    case chars.$t:
      return chars.$TAB;
    case chars.$v:
      return chars.$VTAB;
    default:
      return code;
  }
}

function parseIntAutoRadix(text: string): number {
  const result: number = parseInt(text);
  if (isNaN(result)) {
    throw new Error('Invalid integer literal when parsing ' + text);
  }
  return result;
}
