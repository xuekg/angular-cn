/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import ts from 'typescript';

import {OwningModule, Reference} from '../../imports';
import {ClassDeclaration, isNamedClassDeclaration, ReflectionHost, TypeValueReferenceKind} from '../../reflection';
import {nodeDebugInfo} from '../../util/src/typescript';

import {DirectiveMeta, HostDirectiveMeta, MatchSource, MetadataReader, MetaKind, NgModuleMeta, PipeMeta} from './api';
import {ClassPropertyMapping} from './property_mapping';
import {extractDirectiveTypeCheckMeta, extractReferencesFromType, extraReferenceFromTypeQuery, readBooleanType, readMapType, readStringArrayType, readStringType} from './util';

/**
 * A `MetadataReader` that can read metadata from `.d.ts` files, which have static Ivy properties
 * from an upstream compilation already.
 *
 * 一个 `MetadataReader` ，可以从 `.d.ts` 文件中读取元数据，这些文件已经具有来自上游编译的静态 Ivy
 * 属性。
 *
 */
export class DtsMetadataReader implements MetadataReader {
  constructor(private checker: ts.TypeChecker, private reflector: ReflectionHost) {}

  /**
   * Read the metadata from a class that has already been compiled somehow (either it's in a .d.ts
   * file, or in a .ts file with a handwritten definition).
   *
   * 从已经以某种方式编译的类中读取元数据（它在 .d.ts 文件中，或在具有手写定义的 .ts 文件中）。
   *
   * @param ref `Reference` to the class of interest, with the context of how it was obtained.
   *
   * 对感兴趣的类的 `Reference` ，以及它是如何获取的上下文。
   *
   */
  getNgModuleMetadata(ref: Reference<ClassDeclaration>): NgModuleMeta|null {
    const clazz = ref.node;

    // This operation is explicitly not memoized, as it depends on `ref.ownedByModuleGuess`.
    // TODO(alxhub): investigate caching of .d.ts module metadata.
    const ngModuleDef = this.reflector.getMembersOfClass(clazz).find(
        member => member.name === 'ɵmod' && member.isStatic);
    if (ngModuleDef === undefined) {
      return null;
    } else if (
        // Validate that the shape of the ngModuleDef type is correct.
        ngModuleDef.type === null || !ts.isTypeReferenceNode(ngModuleDef.type) ||
        ngModuleDef.type.typeArguments === undefined ||
        ngModuleDef.type.typeArguments.length !== 4) {
      return null;
    }

    // Read the ModuleData out of the type arguments.
    const [_, declarationMetadata, importMetadata, exportMetadata] = ngModuleDef.type.typeArguments;
    return {
      kind: MetaKind.NgModule,
      ref,
      declarations:
          extractReferencesFromType(this.checker, declarationMetadata, ref.bestGuessOwningModule),
      exports: extractReferencesFromType(this.checker, exportMetadata, ref.bestGuessOwningModule),
      imports: extractReferencesFromType(this.checker, importMetadata, ref.bestGuessOwningModule),
      schemas: [],
      rawDeclarations: null,
      rawImports: null,
      rawExports: null,
      decorator: null,
    };
  }

  /**
   * Read directive (or component) metadata from a referenced class in a .d.ts file.
   *
   * 从 .d.ts 文件中的引用类读取指令（或组件）元数据。
   *
   */
  getDirectiveMetadata(ref: Reference<ClassDeclaration>): DirectiveMeta|null {
    const clazz = ref.node;
    const def = this.reflector.getMembersOfClass(clazz).find(
        field => field.isStatic && (field.name === 'ɵcmp' || field.name === 'ɵdir'));
    if (def === undefined) {
      // No definition could be found.
      return null;
    } else if (
        def.type === null || !ts.isTypeReferenceNode(def.type) ||
        def.type.typeArguments === undefined || def.type.typeArguments.length < 2) {
      // The type metadata was the wrong shape.
      return null;
    }

    const isComponent = def.name === 'ɵcmp';

    const ctorParams = this.reflector.getConstructorParameters(clazz);

    // A directive is considered to be structural if:
    // 1) it's a directive, not a component, and
    // 2) it injects `TemplateRef`
    const isStructural = !isComponent && ctorParams !== null && ctorParams.some(param => {
      return param.typeValueReference.kind === TypeValueReferenceKind.IMPORTED &&
          param.typeValueReference.moduleName === '@angular/core' &&
          param.typeValueReference.importedName === 'TemplateRef';
    });

    const isStandalone =
        def.type.typeArguments.length > 7 && (readBooleanType(def.type.typeArguments[7]) ?? false);

    const inputs = ClassPropertyMapping.fromMappedObject(
        readMapType(def.type.typeArguments[3], readStringType));
    const outputs = ClassPropertyMapping.fromMappedObject(
        readMapType(def.type.typeArguments[4], readStringType));
    const hostDirectives = def.type.typeArguments.length > 8 ?
        readHostDirectivesType(this.checker, def.type.typeArguments[8], ref.bestGuessOwningModule) :
        null;

    return {
      kind: MetaKind.Directive,
      matchSource: MatchSource.Selector,
      ref,
      name: clazz.name.text,
      isComponent,
      selector: readStringType(def.type.typeArguments[1]),
      exportAs: readStringArrayType(def.type.typeArguments[2]),
      inputs,
      outputs,
      hostDirectives,
      queries: readStringArrayType(def.type.typeArguments[5]),
      ...extractDirectiveTypeCheckMeta(clazz, inputs, this.reflector),
      baseClass: readBaseClass(clazz, this.checker, this.reflector),
      isPoisoned: false,
      isStructural,
      animationTriggerNames: null,
      isStandalone,
      // Imports are tracked in metadata only for template type-checking purposes,
      // so standalone components from .d.ts files don't have any.
      imports: null,
      // The same goes for schemas.
      schemas: null,
      decorator: null,
    };
  }

  /**
   * Read pipe metadata from a referenced class in a .d.ts file.
   *
   * 从 .d.ts 文件中的引用类读取管道元数据。
   *
   */
  getPipeMetadata(ref: Reference<ClassDeclaration>): PipeMeta|null {
    const def = this.reflector.getMembersOfClass(ref.node).find(
        field => field.isStatic && field.name === 'ɵpipe');
    if (def === undefined) {
      // No definition could be found.
      return null;
    } else if (
        def.type === null || !ts.isTypeReferenceNode(def.type) ||
        def.type.typeArguments === undefined || def.type.typeArguments.length < 2) {
      // The type metadata was the wrong shape.
      return null;
    }
    const type = def.type.typeArguments[1];
    if (!ts.isLiteralTypeNode(type) || !ts.isStringLiteral(type.literal)) {
      // The type metadata was the wrong type.
      return null;
    }
    const name = type.literal.text;

    const isStandalone =
        def.type.typeArguments.length > 2 && (readBooleanType(def.type.typeArguments[2]) ?? false);

    return {
      kind: MetaKind.Pipe,
      ref,
      name,
      nameExpr: null,
      isStandalone,
      decorator: null,
    };
  }
}

function readBaseClass(clazz: ClassDeclaration, checker: ts.TypeChecker, reflector: ReflectionHost):
    Reference<ClassDeclaration>|'dynamic'|null {
  if (!isNamedClassDeclaration(clazz)) {
    // Technically this is an error in a .d.ts file, but for the purposes of finding the base class
    // it's ignored.
    return reflector.hasBaseClass(clazz) ? 'dynamic' : null;
  }

  if (clazz.heritageClauses !== undefined) {
    for (const clause of clazz.heritageClauses) {
      if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
        const baseExpr = clause.types[0].expression;
        let symbol = checker.getSymbolAtLocation(baseExpr);
        if (symbol === undefined) {
          return 'dynamic';
        } else if (symbol.flags & ts.SymbolFlags.Alias) {
          symbol = checker.getAliasedSymbol(symbol);
        }
        if (symbol.valueDeclaration !== undefined &&
            isNamedClassDeclaration(symbol.valueDeclaration)) {
          return new Reference(symbol.valueDeclaration);
        } else {
          return 'dynamic';
        }
      }
    }
  }
  return null;
}


function readHostDirectivesType(
    checker: ts.TypeChecker, type: ts.TypeNode,
    bestGuessOwningModule: OwningModule|null): HostDirectiveMeta[]|null {
  if (!ts.isTupleTypeNode(type) || type.elements.length === 0) {
    return null;
  }

  const result: HostDirectiveMeta[] = [];

  for (const hostDirectiveType of type.elements) {
    const {directive, inputs, outputs} = readMapType(hostDirectiveType, type => type);

    if (directive) {
      if (!ts.isTypeQueryNode(directive)) {
        throw new Error(`Expected TypeQueryNode: ${nodeDebugInfo(directive)}`);
      }

      result.push({
        directive: extraReferenceFromTypeQuery(checker, directive, type, bestGuessOwningModule),
        isForwardReference: false,
        inputs: readMapType(inputs, readStringType),
        outputs: readMapType(outputs, readStringType)
      });
    }
  }

  return result.length > 0 ? result : null;
}
