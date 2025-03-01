/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {InjectionToken, Injector} from '@angular/core';

import {Metric} from '../metric';

export class MultiMetric extends Metric {
  static provideWith(childTokens: any[]): any[] {
    return [
      {
        provide: _CHILDREN,
        useFactory: (injector: Injector) => childTokens.map(token => injector.get(token)),
        deps: [Injector]
      },
      {
        provide: MultiMetric,
        useFactory: (children: Metric[]) => new MultiMetric(children),
        deps: [_CHILDREN]
      }
    ];
  }

  constructor(private _metrics: Metric[]) {
    super();
  }

  /**
   * Starts measuring
   *
   * 开始测量
   *
   */
  override beginMeasure(): Promise<any> {
    return Promise.all(this._metrics.map(metric => metric.beginMeasure()));
  }

  /**
   * Ends measuring and reports the data
   * since the begin call.
   *
   * 结束测量并报告自 begin 调用以来的数据。
   *
   * @param restart: Whether to restart right after this.
   */
  override endMeasure(restart: boolean): Promise<{[key: string]: any}> {
    return Promise.all(this._metrics.map(metric => metric.endMeasure(restart)))
        .then(values => mergeStringMaps(<any>values));
  }

  /**
   * Describes the metrics provided by this metric implementation.
   * (e.g. units, ...)
   *
   * 描述此度量实现提供的度量。（例如单位，……）
   *
   */
  override describe(): {[key: string]: any} {
    return mergeStringMaps(this._metrics.map((metric) => metric.describe()));
  }
}

function mergeStringMaps(maps: {[key: string]: string}[]): {[key: string]: string} {
  const result: {[key: string]: string} = {};
  maps.forEach(map => {
    Object.keys(map).forEach(prop => {
      result[prop] = map[prop];
    });
  });
  return result;
}

const _CHILDREN = new InjectionToken('MultiMetric.children');
