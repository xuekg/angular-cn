/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import ts from 'typescript';

import {absoluteFromSourceFile, AbsoluteFsPath, basename} from '../../file_system';
import {ImportRewriter} from '../../imports';
import {getDecorators, getModifiers, updateImportDeclaration} from '../../ts_compatibility';
import {FactoryInfo, FactoryTracker, ModuleInfo, PerFileShimGenerator} from '../api';

import {generatedModuleName} from './util';

const TS_DTS_SUFFIX = /(\.d)?\.ts$/;
const STRIP_NG_FACTORY = /(.*)NgFactory$/;

/**
 * Generates ts.SourceFiles which contain variable declarations for NgFactories for every exported
 * class of an input ts.SourceFile.
 *
 * 生成 ts.SourceFiles ，其中包含输入 ts.SourceFile 的每个导出类的 NgFactories 的变量声明。
 *
 */
export class FactoryGenerator implements PerFileShimGenerator, FactoryTracker {
  readonly sourceInfo = new Map<string, FactoryInfo>();
  private sourceToFactorySymbols = new Map<string, Map<string, ModuleInfo>>();

  readonly shouldEmit = true;
  readonly extensionPrefix = 'ngfactory';

  generateShimForFile(sf: ts.SourceFile, genFilePath: AbsoluteFsPath): ts.SourceFile {
    const absoluteSfPath = absoluteFromSourceFile(sf);

    const relativePathToSource = './' + basename(sf.fileName).replace(TS_DTS_SUFFIX, '');
    // Collect a list of classes that need to have factory types emitted for them. This list is
    // overly broad as at this point the ts.TypeChecker hasn't been created, and can't be used to
    // semantically understand which decorated types are actually decorated with Angular decorators.
    //
    // The exports generated here are pruned in the factory transform during emit.
    const symbolNames = sf.statements
                            // Pick out top level class declarations...
                            .filter(ts.isClassDeclaration)
                            // which are named, exported, and have decorators.
                            .filter(
                                decl => isExported(decl) && getDecorators(decl) !== undefined &&
                                    decl.name !== undefined)
                            // Grab the symbol name.
                            .map(decl => decl.name!.text);


    let sourceText = '';

    // If there is a top-level comment in the original file, copy it over at the top of the
    // generated factory file. This is important for preserving any load-bearing jsdoc comments.
    const leadingComment = getFileoverviewComment(sf);
    if (leadingComment !== null) {
      // Leading comments must be separated from the rest of the contents by a blank line.
      sourceText = leadingComment + '\n\n';
    }

    if (symbolNames.length > 0) {
      // For each symbol name, generate a constant export of the corresponding NgFactory.
      // This will encompass a lot of symbols which don't need factories, but that's okay
      // because it won't miss any that do.
      const varLines = symbolNames.map(
          name => `export const ${
              name}NgFactory: i0.ɵNgModuleFactory<any> = new i0.ɵNgModuleFactory(${name});`);
      sourceText += [
        // This might be incorrect if the current package being compiled is Angular core, but it's
        // okay to leave in at type checking time. TypeScript can handle this reference via its path
        // mapping, but downstream bundlers can't. If the current package is core itself, this will
        // be replaced in the factory transformer before emit.
        `import * as i0 from '@angular/core';`,
        `import {${symbolNames.join(', ')}} from '${relativePathToSource}';`,
        ...varLines,
      ].join('\n');
    }

    // Add an extra export to ensure this module has at least one. It'll be removed later in the
    // factory transformer if it ends up not being needed.
    sourceText += '\nexport const ɵNonEmptyModule = true;';

    const genFile =
        ts.createSourceFile(genFilePath, sourceText, sf.languageVersion, true, ts.ScriptKind.TS);
    if (sf.moduleName !== undefined) {
      genFile.moduleName = generatedModuleName(sf.moduleName, sf.fileName, '.ngfactory');
    }

    const moduleSymbols = new Map<string, ModuleInfo>();
    this.sourceToFactorySymbols.set(absoluteSfPath, moduleSymbols);
    this.sourceInfo.set(genFilePath, {
      sourceFilePath: absoluteSfPath,
      moduleSymbols,
    });

    return genFile;
  }

  track(sf: ts.SourceFile, moduleInfo: ModuleInfo): void {
    if (this.sourceToFactorySymbols.has(sf.fileName)) {
      this.sourceToFactorySymbols.get(sf.fileName)!.set(moduleInfo.name, moduleInfo);
    }
  }
}

function isExported(decl: ts.Declaration): boolean {
  const modifiers = getModifiers(decl);
  return modifiers !== undefined && modifiers.some(mod => mod.kind == ts.SyntaxKind.ExportKeyword);
}

export function generatedFactoryTransform(
    factoryMap: Map<string, FactoryInfo>,
    importRewriter: ImportRewriter): ts.TransformerFactory<ts.SourceFile> {
  return (context: ts.TransformationContext): ts.Transformer<ts.SourceFile> => {
    return (file: ts.SourceFile): ts.SourceFile => {
      return transformFactorySourceFile(factoryMap, context, importRewriter, file);
    };
  };
}

function transformFactorySourceFile(
    factoryMap: Map<string, FactoryInfo>, context: ts.TransformationContext,
    importRewriter: ImportRewriter, file: ts.SourceFile): ts.SourceFile {
  // If this is not a generated file, it won't have factory info associated with it.
  if (!factoryMap.has(file.fileName)) {
    // Don't transform non-generated code.
    return file;
  }

  const {moduleSymbols, sourceFilePath} = factoryMap.get(file.fileName)!;

  // Not every exported factory statement is valid. They were generated before the program was
  // analyzed, and before ngtsc knew which symbols were actually NgModules. factoryMap contains
  // that knowledge now, so this transform filters the statement list and removes exported factories
  // that aren't actually factories.
  //
  // This could leave the generated factory file empty. To prevent this (it causes issues with
  // closure compiler) a 'ɵNonEmptyModule' export was added when the factory shim was created.
  // Preserve that export if needed, and remove it otherwise.
  //
  // Additionally, an import to @angular/core is generated, but the current compilation unit could
  // actually be @angular/core, in which case such an import is invalid and should be replaced with
  // the proper path to access Ivy symbols in core.

  // The filtered set of statements.
  const transformedStatements: ts.Statement[] = [];

  // The statement identified as the ɵNonEmptyModule export.
  let nonEmptyExport: ts.Statement|null = null;

  // Extracted identifiers which refer to import statements from @angular/core.
  const coreImportIdentifiers = new Set<string>();

  // Consider all the statements.
  for (const stmt of file.statements) {
    // Look for imports to @angular/core.
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier) &&
        stmt.moduleSpecifier.text === '@angular/core') {
      // Update the import path to point to the correct file using the ImportRewriter.
      const rewrittenModuleSpecifier =
          importRewriter.rewriteSpecifier('@angular/core', sourceFilePath);
      if (rewrittenModuleSpecifier !== stmt.moduleSpecifier.text) {
        transformedStatements.push(updateImportDeclaration(
            stmt, getModifiers(stmt), stmt.importClause,
            ts.factory.createStringLiteral(rewrittenModuleSpecifier), undefined));

        // Record the identifier by which this imported module goes, so references to its symbols
        // can be discovered later.
        if (stmt.importClause !== undefined && stmt.importClause.namedBindings !== undefined &&
            ts.isNamespaceImport(stmt.importClause.namedBindings)) {
          coreImportIdentifiers.add(stmt.importClause.namedBindings.name.text);
        }
      } else {
        transformedStatements.push(stmt);
      }
    } else if (ts.isVariableStatement(stmt) && stmt.declarationList.declarations.length === 1) {
      const decl = stmt.declarationList.declarations[0];

      // If this is the ɵNonEmptyModule export, then save it for later.
      if (ts.isIdentifier(decl.name)) {
        if (decl.name.text === 'ɵNonEmptyModule') {
          nonEmptyExport = stmt;
          continue;
        }

        // Otherwise, check if this export is a factory for a known NgModule, and retain it if so.
        const match = STRIP_NG_FACTORY.exec(decl.name.text);
        const module = match ? moduleSymbols.get(match[1]) : null;
        if (module) {
          // The factory should be wrapped in a `noSideEffects()` call which tells Closure to treat
          // the expression as pure, allowing it to be removed if the result is not used.
          transformedStatements.push(updateInitializers(
              stmt,
              (init) => init ? wrapInNoSideEffects(init) : undefined,
              ));
        }
      } else {
        // Leave the statement alone, as it can't be understood.
        transformedStatements.push(stmt);
      }
    } else {
      // Include non-variable statements (imports, etc).
      transformedStatements.push(stmt);
    }
  }

  // Check whether the empty module export is still needed.
  if (!transformedStatements.some(ts.isVariableStatement) && nonEmptyExport !== null) {
    // If the resulting file has no factories, include an empty export to
    // satisfy closure compiler.
    transformedStatements.push(nonEmptyExport);
  }

  file = ts.factory.updateSourceFile(file, transformedStatements);

  // If any imports to @angular/core were detected and rewritten (which happens when compiling
  // @angular/core), go through the SourceFile and rewrite references to symbols imported from core.
  if (coreImportIdentifiers.size > 0) {
    const visit = <T extends ts.Node>(node: T): T => {
      node = ts.visitEachChild(node, child => visit(child), context);

      // Look for expressions of the form "i.s" where 'i' is a detected name for an @angular/core
      // import that was changed above. Rewrite 's' using the ImportResolver.
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) &&
          coreImportIdentifiers.has(node.expression.text)) {
        // This is an import of a symbol from @angular/core. Transform it with the importRewriter.
        const rewrittenSymbol = importRewriter.rewriteSymbol(node.name.text, '@angular/core');
        if (rewrittenSymbol !== node.name.text) {
          const updated = ts.factory.updatePropertyAccessExpression(
              node, node.expression, ts.factory.createIdentifier(rewrittenSymbol));
          node = updated as T & ts.PropertyAccessExpression;
        }
      }
      return node;
    };

    file = visit(file);
  }

  return file;
}


/**
 * Parses and returns the comment text of a \\@fileoverview comment in the given source file.
 *
 * 解析并返回给定源文件中 \\@fileoverview 注释的注释文本。
 *
 */
function getFileoverviewComment(sourceFile: ts.SourceFile): string|null {
  const text = sourceFile.getFullText();
  const trivia = text.substring(0, sourceFile.getStart());

  const leadingComments = ts.getLeadingCommentRanges(trivia, 0);
  if (!leadingComments || leadingComments.length === 0) {
    return null;
  }

  const comment = leadingComments[0];
  if (comment.kind !== ts.SyntaxKind.MultiLineCommentTrivia) {
    return null;
  }

  // Only comments separated with a \n\n from the file contents are considered file-level comments
  // in TypeScript.
  if (text.substring(comment.end, comment.end + 2) !== '\n\n') {
    return null;
  }

  const commentText = text.substring(comment.pos, comment.end);
  // Closure Compiler ignores @suppress and similar if the comment contains @license.
  if (commentText.indexOf('@license') !== -1) {
    return null;
  }

  return commentText;
}

/**
 * Wraps the given expression in a call to `ɵnoSideEffects()`, which tells
 * Closure we don't care about the side effects of this expression and it should
 * be treated as "pure". Closure is free to tree shake this expression if its
 * result is not used.
 *
 * 在对 `ɵnoSideEffects()` 的调用中包装给定表达式，这告诉 Closure
 * 我们不关心此表达式的副作用，它应该被视为“纯”。如果不使用其结果，闭包可以自由对此表达式进行树形抖动。
 *
 * Example: Takes `1 + 2` and returns `i0.ɵnoSideEffects(() => 1 + 2)`.
 *
 * 示例：接受 `1 + 2` 并返回 `i0.ɵnoSideEffects(() => 1 + 2)` 。
 *
 */
function wrapInNoSideEffects(expr: ts.Expression): ts.Expression {
  const noSideEffects = ts.factory.createPropertyAccessExpression(
      ts.factory.createIdentifier('i0'),
      'ɵnoSideEffects',
  );

  return ts.factory.createCallExpression(
      noSideEffects,
      /* typeArguments */[],
      /* arguments */
      [
        ts.factory.createFunctionExpression(
            /* modifiers */[],
            /* asteriskToken */ undefined,
            /* name */ undefined,
            /* typeParameters */[],
            /* parameters */[],
            /* type */ undefined,
            /* body */ ts.factory.createBlock([
              ts.factory.createReturnStatement(expr),
            ]),
            ),
      ],
  );
}

/**
 * Clones and updates the initializers for a given statement to use the new
 * expression provided. Does not mutate the input statement.
 *
 * 克隆并更新给定语句的初始化器以使用提供的 new 表达式。不会改变输入语句。
 *
 */
function updateInitializers(
    stmt: ts.VariableStatement,
    update: (initializer?: ts.Expression) => ts.Expression | undefined,
    ): ts.VariableStatement {
  return ts.factory.updateVariableStatement(
      stmt,
      getModifiers(stmt),
      ts.factory.updateVariableDeclarationList(
          stmt.declarationList,
          stmt.declarationList.declarations.map(
              (decl) => ts.factory.updateVariableDeclaration(
                  decl,
                  decl.name,
                  decl.exclamationToken,
                  decl.type,
                  update(decl.initializer),
                  ),
              ),
          ),
  );
}
