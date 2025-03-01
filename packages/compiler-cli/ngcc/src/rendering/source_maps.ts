/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import mapHelpers from 'convert-source-map';
import MagicString from 'magic-string';
import ts from 'typescript';

import {absoluteFrom, absoluteFromSourceFile, ReadonlyFileSystem} from '../../../src/ngtsc/file_system';
import {Logger} from '../../../src/ngtsc/logging';
import {ContentOrigin, RawSourceMap, SourceFileLoader} from '../../../src/ngtsc/sourcemaps';

import {FileToWrite} from './utils';

export interface SourceMapInfo {
  source: string;
  map: mapHelpers.SourceMapConverter|null;
  isInline: boolean;
}

/**
 * Merge the input and output source-maps, replacing the source-map comment in the output file
 * with an appropriate source-map comment pointing to the merged source-map.
 *
 * 合并输入和输出 source-maps，将输出文件中的 source-map 注释替换为指向合并后的 source-map 的适当
 * source-map 注释。
 *
 */
export function renderSourceAndMap(
    logger: Logger, fs: ReadonlyFileSystem, sourceFile: ts.SourceFile,
    generatedMagicString: MagicString): FileToWrite[] {
  const sourceFilePath = absoluteFromSourceFile(sourceFile);
  const sourceMapPath = absoluteFrom(`${sourceFilePath}.map`);
  const generatedContent = generatedMagicString.toString();
  const generatedMap: RawSourceMap = generatedMagicString.generateMap(
      {file: sourceFilePath, source: sourceFilePath, includeContent: true});

  try {
    const loader = new SourceFileLoader(fs, logger, {});
    const generatedFile = loader.loadSourceFile(
        sourceFilePath, generatedContent, {map: generatedMap, mapPath: sourceMapPath});

    const rawMergedMap: RawSourceMap = generatedFile.renderFlattenedSourceMap();
    const mergedMap = mapHelpers.fromObject(rawMergedMap);
    const originalFile = loader.loadSourceFile(sourceFilePath, generatedMagicString.original);
    if (originalFile.rawMap === null && !sourceFile.isDeclarationFile ||
        originalFile.rawMap?.origin === ContentOrigin.Inline) {
      // We render an inline source map if one of:
      // * there was no input source map and this is not a typings file;
      // * the input source map exists and was inline.
      //
      // We do not generate inline source maps for typings files unless there explicitly was one in
      // the input file because these inline source maps can be very large and it impacts on the
      // performance of IDEs that need to read them to provide intellisense etc.
      return [
        {path: sourceFilePath, contents: `${generatedFile.contents}\n${mergedMap.toComment()}`}
      ];
    }

    const sourceMapComment =
        mapHelpers.generateMapFileComment(`${fs.basename(sourceFilePath)}.map`);
    return [
      {path: sourceFilePath, contents: `${generatedFile.contents}\n${sourceMapComment}`},
      {path: sourceMapPath, contents: mergedMap.toJSON()}
    ];
  } catch (e) {
    logger.error(`Error when flattening the source-map "${sourceMapPath}" for "${
        sourceFilePath}": ${(e as Error).toString()}`);
    return [
      {path: sourceFilePath, contents: generatedContent},
      {path: sourceMapPath, contents: mapHelpers.fromObject(generatedMap).toJSON()},
    ];
  }
}
