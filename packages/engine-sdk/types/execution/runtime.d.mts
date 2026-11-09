import type {ExecutionUnit} from '../execution.mjs';
import type {OperationalStore} from './storage.mjs';
import type {ContentStore} from '../content.mjs';
import type {NamespaceScope} from '../namespace.mjs';
export interface ExecutionOwnerToken {readonly hostId:string;readonly instanceId:string;readonly id:string}
export interface ExecutionOwner {
  acquire():Promise<ExecutionOwnerToken>;assert(token:ExecutionOwnerToken):Promise<true>;release(token:ExecutionOwnerToken):Promise<void>;
}
export declare const DURABLE_EXECUTION_PROFILE:'sgos-durable-execution/v1';
export declare function createNodeExecutionOwner(options:{readonly hostId:string}):Readonly<ExecutionOwner>;
export declare function createDurableExecutionUnit(options:{readonly unit:ExecutionUnit;readonly store:OperationalStore;
  readonly content:ContentStore;readonly scope:NamespaceScope;readonly owner:ExecutionOwner;
  readonly clock:{now():string|Promise<string>}}):Readonly<ExecutionUnit>;
