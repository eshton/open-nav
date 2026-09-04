import { sha3_512 } from './hash.js';
import { toSignatureTimestamp } from '../time.js';

/**
 * A single invoice (or annulment) operation as it contributes to the request
 * signature of a `manageInvoice` / `manageAnnulment` call.
 */
export interface SignedOperation {
  /** 1-based position inside the batch; operations are hashed in index order. */
  index: number;
  /** `CREATE`, `MODIFY`, `STORNO` or `ANNUL`. */
  operation: string;
  /** Base64 encoded payload exactly as it appears in the request XML. */
  base64Payload: string;
}

/**
 * Hash of one invoice operation, as consumed by {@link requestSignature} and
 * as sent in the optional `electronicInvoiceHash` element.
 *
 * NAV defines it as `SHA3-512(operation || base64Payload)`, uppercase hex.
 */
export function operationHash(operation: string, base64Payload: string): string {
  return sha3_512(`${operation}${base64Payload}`);
}

/**
 * Compute the `user/requestSignature` value.
 *
 * NAV specifies the signature as
 *
 * ```text
 * SHA3-512( requestId || yyyyMMddHHmmss(timestamp) || signKey || hash(op1) || hash(op2) ... )
 * ```
 *
 * where the per-operation hashes are only present for `manageInvoice` and
 * `manageAnnulment` requests and must be concatenated in ascending `index`
 * order. The timestamp must be the request header timestamp truncated to
 * whole seconds and rendered in UTC without separators.
 *
 * @param requestId  the `header/requestId` of the same request
 * @param timestamp  the `header/timestamp` of the same request
 * @param signKey    the technical user's signature key (aláírókulcs)
 * @param operations invoice/annulment operations of the batch, if any
 */
export function requestSignature(
  requestId: string,
  timestamp: Date | string,
  signKey: string,
  operations: SignedOperation[] = [],
): string {
  const operationDigests = [...operations]
    .sort((a, b) => a.index - b.index)
    .map((op) => operationHash(op.operation, op.base64Payload))
    .join('');

  return sha3_512(`${requestId}${toSignatureTimestamp(timestamp)}${signKey}${operationDigests}`);
}
