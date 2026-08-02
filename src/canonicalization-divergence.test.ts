/**
 * Test canonicalization differences - run with npm test to use existing test runner
 */

import { describe, it } from 'vitest';
import { createHash } from 'crypto';
// @ts-ignore
import canonicalize from 'canonicalize';

// Portable script canonicalization (from scripts/verify-receipt.mjs)
function portableCanonicalizeLibrary(obj: any): any {
  if (Array.isArray(obj)) {
    return obj.map(portableCanonicalizeLibrary);
  }
  
  if (obj && typeof obj === 'object') {
    const sorted: any = {};
    for (const key of Object.keys(obj).sort()) {
      if (obj[key] !== undefined) {
        sorted[key] = portableCanonicalizeLibrary(obj[key]);
      }
    }
    return sorted;
  }
  
  return obj;
}

describe('canonicalization-divergence', () => {
  const testInputs = [
    // Basic object
    { a: 1, b: 2, c: 3 },
    
    // Non-ASCII characters (em-dash, curly quotes)
    { claim: "Agent's analysis — \"definitely correct\"", verdict: "ALLOW" },
    
    // Number serialization edge cases
    { amount: 1000.0, precision: 0.000000001, exponent: 1e10 },
    
    // Nested arrays and objects
    { 
      evidence: [
        { type: "signed_event", data: { amount: 100.5, recipient: "0xABC" } },
        { type: "supplied", data: null }
      ]
    },
    
    // Undefined fields (should be stripped)
    { a: 1, b: undefined, c: 3, d: null },
    
    // Empty structures
    { empty_obj: {}, empty_array: [], null_val: null },
    
    // String with backslashes and escapes  
    { regex: "\\n\\t\\", path: "C:\\Users\\test" },
    
    // Unicode edge cases
    { emoji: "🔒", chinese: "测试", arabic: "اختبار" },
  ];

  testInputs.forEach((input, i) => {
    it(`should match canonicalization for test case ${i + 1}`, () => {
      console.log(`\nTest ${i + 1}: ${JSON.stringify(input).slice(0, 80)}...`);
      
      // Portable script method
      const portableResult = JSON.stringify(portableCanonicalizeLibrary(input));
      const portableHash = createHash('sha256').update(portableResult, 'utf8').digest('hex');
      
      // npm canonicalize lib method
      const libResult = canonicalize(input) as string;
      const libHash = createHash('sha256').update(libResult, 'utf8').digest('hex');
      
      console.log(`  Portable: ${portableHash.slice(0, 16)}...`);
      console.log(`  Npm lib:  ${libHash.slice(0, 16)}...`);
      
      if (portableHash !== libHash) {
        console.log(`  ❌ DIVERGENCE DETECTED!`);
        console.log(`    Portable output: "${portableResult}"`);
        console.log(`    Lib output:      "${libResult}"`);
        
        // Character-by-character diff for first difference
        const minLen = Math.min(portableResult.length, libResult.length);
        for (let j = 0; j < minLen; j++) {
          if (portableResult[j] !== libResult[j]) {
            console.log(`    First diff at pos ${j}: portable='${portableResult[j]}' (${portableResult.charCodeAt(j)}) vs lib='${libResult[j]}' (${libResult.charCodeAt(j)})`);
            break;
          }
        }
        
        throw new Error(`Canonicalization divergence detected for test case ${i + 1}`);
      } else {
        console.log(`  ✅ Match`);
      }
    });
  });
});