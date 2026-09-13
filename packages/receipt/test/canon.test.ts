import { describe, expect, it } from 'vitest';
import { canonicalize } from '../src/canon.js';
import { generateRsaKeyPair, signEnvelope, verifyEnvelope } from '../src/crypto.js';

describe('canonicalize (Canonical XML 1.0)', () => {
  it('sorts attributes lexicographically', () => {
    expect(canonicalize('<CoreDocument b="2" a="1"/>')).toBe(
      '<CoreDocument a="1" b="2"></CoreDocument>',
    );
  });

  it('expands empty elements to start/end tags', () => {
    expect(canonicalize('<r><x/></r>')).toBe('<r><x></x></r>');
  });

  it('drops comments', () => {
    expect(canonicalize('<r><!-- c --><x>1</x></r>')).toBe('<r><x>1</x></r>');
  });

  it('preserves element whitespace and text content', () => {
    expect(canonicalize('<r>  <x>hi</x>\n</r>')).toBe('<r>  <x>hi</x>\n</r>');
  });

  it('is stable: canonicalising a canonical form is a no-op', () => {
    const once = canonicalize('<CoreDocument z="9" a="1"><b/></CoreDocument>');
    expect(canonicalize(once)).toBe(once);
  });

  it('gives the same signature regardless of attribute order in the source', () => {
    const { privateKey, publicKey } = generateRsaKeyPair(1024);
    const a = Buffer.from(canonicalize('<r a="1" b="2"><x/></r>')).toString('base64');
    const b = Buffer.from(canonicalize('<r b="2" a="1"><x></x></r>')).toString('base64');
    expect(a).toBe(b);
    const sig = signEnvelope(a, privateKey);
    expect(verifyEnvelope(b, sig.envelopeSignature, publicKey)).toBe(true);
  });
});
