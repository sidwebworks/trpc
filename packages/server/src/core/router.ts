/* eslint-disable @typescript-eslint/ban-types */
import { TRPCError } from '../error/TRPCError';
import {
  DefaultErrorShape,
  ErrorFormatter,
  defaultFormatter,
} from '../error/formatter';
import { getHTTPStatusCodeFromError } from '../http/internals/getHTTPStatusCode';
import { TRPCErrorShape, TRPC_ERROR_CODES_BY_KEY } from '../rpc';
import { CombinedDataTransformer, defaultTransformer } from '../transformer';
import { RootConfig } from './internals/config';
import {
  InternalProcedure,
  InternalProcedureCallOptions,
} from './internals/internalProcedure';
import { mergeWithoutOverrides } from './internals/mergeWithoutOverrides';
import { prefixObjectKeys } from './internals/prefixObjectKeys';
import { EnsureRecord, ValidateShape } from './internals/utils';
import { ExplicitProcedure, Procedure } from './procedure';
import { ProcedureType } from './types';

// FIXME this should properly use TContext maybe?
export type ProcedureRecord<_TContext> = Record<string, Procedure<any>>;
type AnyProcedureRecord = ProcedureRecord<any>;
export interface ProcedureStructure {
  queries: AnyProcedureRecord;
  mutations: AnyProcedureRecord;
  subscriptions: AnyProcedureRecord;
  procedures: Record<string, ExplicitProcedure<any>>;
}

export interface RouterParams<
  // FIXME this should use RootConfig
  TContext,
  TErrorShape extends TRPCErrorShape<number>,
  TMeta extends Record<string, unknown>,
  TQueries extends ProcedureRecord<TContext>,
  TMutations extends ProcedureRecord<TContext>,
  TSubscriptions extends ProcedureRecord<TContext>,
  TChildren extends Record<string, AnyRouter>,
  TProcedures extends Record<string, ExplicitProcedure<any>>,
> extends ProcedureStructure {
  /**
   * @internal
   */
  _ctx: TContext;
  /**
   * @internal
   */
  _errorShape: TErrorShape;
  /**
   * @internal
   */
  _meta: TMeta;
  /** @deprecated **/
  queries: TQueries;
  /** @deprecated **/
  mutations: TMutations;
  /** @deprecated **/
  subscriptions: TSubscriptions;
  errorFormatter: ErrorFormatter<TContext, TErrorShape>;
  transformer: CombinedDataTransformer;
  // Maybe a better impl would be `Record<string, Partial<ProcedureStructure>>`? not sure
  children: TChildren;
  procedures: TProcedures;
}

export type AnyRouterParams<TContext = any> = RouterParams<
  TContext,
  any,
  any,
  any,
  any,
  any,
  any,
  any
>;

/**
 * @internal
 */
export type inferHandlerInput<TProcedure extends Procedure<any>> =
  TProcedure extends Procedure<infer TParams>
    ? undefined extends TParams['_input_in'] // ? is input optional
      ? unknown extends TParams['_input_in'] // ? is input unset
        ? [(null | undefined)?] // -> there is no input
        : [(TParams['_input_in'] | null | undefined)?] // -> there is optional input
      : [TParams['_input_in']] // -> input is required
    : [(undefined | null)?]; // -> there is no input

/**
 * @internal
 */
type inferHandlerFn<TProcedures extends ProcedureRecord<any>> = <
  TProcedure extends TProcedures[TPath],
  TPath extends keyof TProcedures & string,
>(
  path: TPath,
  ...args: inferHandlerInput<TProcedure>
) => ReturnType<TProcedure>;

/**
 * This only exists b/c of interop mode
 * @internal
 */

type RouterCaller<TParams extends AnyRouterParams> = (ctx: TParams['_ctx']) => {
  /**
   * @deprecated
   */
  query: inferHandlerFn<TParams['queries']>;
  /**
   * @deprecated
   */
  mutation: inferHandlerFn<TParams['mutations']>;
  /**
   * @deprecated
   */
  subscription: inferHandlerFn<TParams['subscriptions']>;

  queries: TParams['queries'];
  mutations: TParams['mutations'];
  subscriptions: TParams['subscriptions'];
};

export interface Router<TParams extends AnyRouterParams>
  extends ProcedureStructure {
  _def: RouterParams<
    TParams['_ctx'],
    TParams['_errorShape'],
    TParams['_meta'],
    TParams['queries'],
    TParams['mutations'],
    TParams['subscriptions'],
    TParams['children'],
    TParams['procedures']
  >;
  /** @deprecated **/
  queries: TParams['queries'];
  /** @deprecated **/
  mutations: TParams['mutations'];
  /** @deprecated **/
  subscriptions: TParams['subscriptions'];
  /** @deprecated **/
  errorFormatter: TParams['errorFormatter'];
  /** @deprecated **/
  transformer: TParams['transformer'];
  /** @deprecated **/
  children: TParams['children'];

  // FIXME rename me
  createCaller: RouterCaller<TParams>;
  // FIXME rename me
  getErrorShape(opts: {
    error: TRPCError;
    type: ProcedureType | 'unknown';
    path: string | undefined;
    input: unknown;
    ctx: undefined | TParams['_ctx'];
  }): TParams['_errorShape'];
}

/**
 * @internal
 */
export type RouterOptions<TContext> = Partial<AnyRouterParams<TContext>>;

/**
 * @internal
 */
export type RouterDefaultOptions<TContext> = Pick<
  AnyRouterParams<TContext>,
  'transformer' | 'errorFormatter'
>;

/**
 * @internal
 */
export type RouterBuildOptions<TContext> = Pick<
  RouterOptions<TContext>,
  'queries' | 'subscriptions' | 'mutations' | 'children' | 'procedures'
>;

export type AnyRouter = Router<any>;

function createRouterProxy(callback: (...args: [string, ...unknown[]]) => any) {
  return new Proxy({} as any, {
    get(_, path: string) {
      return (...args: unknown[]) => callback(path, ...args);
    },
  });
}
const emptyRouter = {
  _ctx: null as any,
  _errorShape: null as any,
  _meta: null as any,
  queries: {},
  mutations: {},
  subscriptions: {},
  errorFormatter: defaultFormatter,
  transformer: defaultTransformer,
};

/**
 *
 * @internal
 */
export function createRouterFactory<TSettings extends RootConfig>(
  defaults?: RouterDefaultOptions<TSettings['ctx']>,
) {
  return function createRouterInner<
    TProcedures extends RouterBuildOptions<TSettings['ctx']>,
  >(
    opts: ValidateShape<TProcedures, RouterBuildOptions<TSettings['ctx']>>,
  ): Router<{
    _ctx: TSettings['ctx'];
    _errorShape: TSettings['errorShape'];
    _meta: TSettings['meta'];
    queries: EnsureRecord<TProcedures['queries']>;
    mutations: EnsureRecord<TProcedures['mutations']>;
    subscriptions: EnsureRecord<TProcedures['subscriptions']>;
    errorFormatter: ErrorFormatter<TSettings['ctx'], TSettings['errorShape']>;
    transformer: TSettings['transformer'];
    children: EnsureRecord<TProcedures['children']>;
    procedures: EnsureRecord<TProcedures['procedures']>;
  }> {
    const prefixedChildren = Object.entries(opts.children ?? {}).map(
      ([key, childRouter]) => {
        const queries = prefixObjectKeys(
          (childRouter as any).queries,
          `${key}.`,
        );
        const mutations = prefixObjectKeys(
          (childRouter as any).mutations,
          `${key}.`,
        );
        const subscriptions = prefixObjectKeys(
          (childRouter as any).subscriptions,
          `${key}.`,
        );
        const procedures = prefixObjectKeys(
          (childRouter as any).procedures,
          `${key}.`,
        );

        return {
          queries,
          mutations,
          subscriptions,
          procedures,
        };
      },
    );
    const routerProcedures = {
      queries: mergeWithoutOverrides(
        opts.queries,
        ...prefixedChildren.map((child) => child.queries),
      ),
      mutations: mergeWithoutOverrides(
        opts.mutations,
        ...prefixedChildren.map((child) => child.mutations),
      ),
      subscriptions: mergeWithoutOverrides(
        opts.subscriptions,
        ...prefixedChildren.map((child) => child.subscriptions),
      ),
      procedures: mergeWithoutOverrides(
        opts.procedures,
        opts.subscriptions,
        opts.queries,
        opts.mutations,
        ...prefixedChildren.map((child) => child.procedures),
      ),

      children: opts.children || {},
    };

    const result = mergeWithoutOverrides<
      RouterDefaultOptions<TSettings['ctx']> &
        RouterBuildOptions<TSettings['ctx']>
    >(
      {
        transformer: defaults?.transformer ?? defaultTransformer,
        errorFormatter: defaults?.errorFormatter ?? defaultFormatter,
      },
      routerProcedures,
    );

    const _def: AnyRouterParams<TSettings['ctx']> = {
      children: {},
      procedures: {},
      ...emptyRouter,
      ...result,
    };
    const def = {
      _def,
      ..._def,
    };

    function callProcedure(opts: InternalProcedureCallOptions) {
      const { type, path } = opts;

      if (!(path in def.procedures)) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `No "${type}"-procedure on path "${path}"`,
        });
      }

      const procedure = def.procedures[path] as InternalProcedure;
      return procedure(opts);
    }
    const router: AnyRouter = {
      ...def,
      children: opts.children,
      createCaller(ctx) {
        return {
          query: (path, ...args) =>
            callProcedure({
              path,
              rawInput: args[0],
              ctx,
              type: 'query',
            }) as any,
          mutation: (path, ...args) =>
            callProcedure({
              path,
              rawInput: args[0],
              ctx,
              type: 'mutation',
            }) as any,
          subscription: (path, ...args) =>
            callProcedure({
              path,
              rawInput: args[0],
              ctx,
              type: 'subscription',
            }) as any,

          queries: createRouterProxy((path, rawInput) =>
            callProcedure({
              path,
              rawInput,
              ctx,
              type: 'query',
            }),
          ),
          mutations: createRouterProxy((path, rawInput) =>
            callProcedure({
              path,
              rawInput,
              ctx,
              type: 'mutation',
            }),
          ),
          subscriptions: createRouterProxy((path, rawInput) =>
            callProcedure({
              path,
              rawInput,
              ctx,
              type: 'subscription',
            }),
          ),
        };
      },
      getErrorShape(opts) {
        const { path, error } = opts;
        const { code } = opts.error;
        const shape: DefaultErrorShape = {
          message: error.message,
          code: TRPC_ERROR_CODES_BY_KEY[code],
          data: {
            code,
            httpStatus: getHTTPStatusCodeFromError(error),
          },
        };
        if (
          process.env.NODE_ENV !== 'production' &&
          typeof opts.error.stack === 'string'
        ) {
          shape.data.stack = opts.error.stack;
        }
        if (typeof path === 'string') {
          shape.data.path = path;
        }
        return this._def.errorFormatter({ ...opts, shape });
      },
    };
    return router as any;
  };
}

type combineProcedureRecords<
  A extends Partial<AnyRouter>,
  B extends Partial<AnyRouter>,
> = {
  queries: A['queries'] & B['queries'];
  mutations: A['mutations'] & B['mutations'];
  subscriptions: A['subscriptions'] & B['subscriptions'];
};
/**
 * @internal
 */
export type mergeProcedureRecordsVariadic<
  Routers extends Partial<AnyRouter>[],
> = Routers extends []
  ? {
      queries: {};
      mutations: {};
      subscriptions: {};
    }
  : Routers extends [infer First, ...infer Rest]
  ? First extends Partial<AnyRouter>
    ? Rest extends Partial<AnyRouter>[]
      ? combineProcedureRecords<First, mergeProcedureRecordsVariadic<Rest>>
      : never
    : never
  : never;
