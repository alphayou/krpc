/**
 * Type-safe, zero-dependency JSON-RPC 2.0 library for TypeScript built on Web Standard APIs.
 *
 * @module krpc
 */

export {
  defineError,
  internalError,
  invalidParams,
  invalidRequest,
  isJsonRpcError,
  isRpcErrorValue,
  JsonRpcError,
  KrpcTimeoutError,
  KrpcTransportError,
  methodNotFound,
  parseError,
  RPC_ERROR_BRAND,
  serverError,
  type KrpcTransportErrorOptions,
  type RpcDataErrorFactory,
  type RpcErrorFactory,
  type RpcErrorObject,
  type RpcErrorValue,
  type ValidateCustomErrorCode,
} from './protocol/errors'

export {
  isJsonRpcErrorObject,
  isJsonRpcErrorResponse,
  isJsonRpcId,
  isJsonRpcNotification,
  isJsonRpcParams,
  isJsonRpcRequest,
  isJsonRpcResponse,
  isJsonRpcSuccessResponse,
  isPlainObject,
  isReservedRpcMethod,
  parseJsonRpcPayload,
} from './protocol/guards'

export {
  isStandardSchema,
  validateStandardSchema,
  type InferInput as InferSchemaInput,
  type InferOutput as InferSchemaOutput,
  type StandardSchemaIssue,
  type StandardSchemaV1,
  type StandardSchemaValidationResult,
} from './protocol/standard-schema'

export {
  err,
  JSON_RPC_ERROR_CODES,
  ok,
  type JsonRpcErrorObject,
  type JsonRpcErrorResponse,
  type JsonRpcId,
  type JsonRpcNotification,
  type JsonRpcParams,
  type JsonRpcPayload,
  type JsonRpcRequest,
  type JsonRpcRequestPayload,
  type JsonRpcResponse,
  type JsonRpcResponsePayload,
  type JsonRpcSingleRequest,
  type JsonRpcSuccessResponse,
  type JsonRpcVersion,
  type Result,
  type StandardJsonRpcErrorCode,
  type StandardRpcError,
} from './protocol/types'

export {
  createRpcContext,
  defineContext,
  type AnyContextToken,
  type ContextToken,
  type ContextTokenWithDefault,
  type CreateRpcContextOptions,
  type RpcContext,
} from './service/context'

export {
  onAfter,
  onBefore,
  onError,
  type AfterHook,
  type BeforeHook,
  type ErrorHook,
  type ServiceHookLayer,
} from './service/hooks'

export {
  defineMethod,
  defineNotify,
  isMethodDef,
  isNotifyDef,
  METHOD_BRAND,
  NOTIFY_BRAND,
  type CallArgs,
  type InferMethodErrors,
  type InferMethodValue,
  type MethodDef,
  type MethodSchemaOptions,
  type NotifyDef,
  type ValidRpcParams,
} from './service/method'

export {
  compileService,
  defineService,
  isServiceDef,
  SERVICE_BRAND,
  type CompiledService,
  type ServiceDef,
  type ServiceTree,
} from './service/service'

export type {
  FlattenService,
  InferError,
  InferInput,
  InferNotify,
  InferOutput,
  MethodMap,
  MethodNames,
  NotifyMap,
  NotifyNames,
  ToClientError,
} from './service/types'

export {
  createServer,
  type HandleOptions,
  type ResolvedNotify,
  type RpcServer,
  type ServerOptions,
} from './server/server'

export {
  createClient,
  type BatchBuilder,
  type BatchCallItem,
  type BatchItem,
  type BatchNotifyItem,
  type BatchResults,
  type CallArgsWithOptions,
  type CallOptions,
  type ClientOptions,
  type KrpcClient,
} from './client/client'

export { createProxy, type RpcProxy } from './client/proxy'

export {
  createPeer,
  type KrpcPeer,
  type PeerNotifyHandler,
  type PeerNotifyInput,
  type PeerNotifyNames,
  type PeerOptions,
} from './peer/peer'

export { batchTransport, type BatchTransportOptions } from './transports/batch'

export {
  createMemoryDuplexPair,
  createMemoryTransport,
  type MemoryTransportOptions,
} from './transports/memory'

export {
  isDuplexTransport,
  type ClientTransport,
  type DuplexTransport,
  type TransportSendOptions,
} from './transports/types'
