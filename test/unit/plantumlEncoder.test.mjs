/**
 * Tests for the PlantUML URL text encoding.
 *
 * The round-trip test is the meaningful one: it decodes with an independent
 * implementation of the alphabet, so a transposed character in the encoder
 * cannot pass by matching itself.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inflateRawSync } from 'node:zlib';

import { encodePlantUmlText, PLANTUML_ALPHABET } from '../../out/extension/render/plantumlEncoder.js';

/** Decodes PlantUML's 6-bit alphabet back to bytes, written independently. */
function decodePlantUml(encoded) {
  const values = [...encoded].map((character) => {
    const index = PLANTUML_ALPHABET.indexOf(character);
    assert.notEqual(index, -1, `"${character}" is not in the alphabet`);
    return index;
  });

  const bytes = [];
  for (let i = 0; i < values.length; i += 4) {
    const [c1 = 0, c2 = 0, c3 = 0, c4 = 0] = values.slice(i, i + 4);
    bytes.push(((c1 << 2) | (c2 >> 4)) & 0xff);
    bytes.push((((c2 & 0x0f) << 4) | (c3 >> 2)) & 0xff);
    bytes.push((((c3 & 0x03) << 6) | c4) & 0xff);
  }
  return Buffer.from(bytes);
}

describe('PLANTUML_ALPHABET', () => {
  it('is exactly PlantUML’s ordering, not standard base64', () => {
    assert.equal(
      PLANTUML_ALPHABET,
      '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_',
    );
    assert.equal(PLANTUML_ALPHABET.length, 64);
    assert.equal(new Set(PLANTUML_ALPHABET).size, 64, 'every symbol must be distinct');
  });

  it('is URL-safe', () => {
    assert.match(PLANTUML_ALPHABET, /^[A-Za-z0-9_-]+$/u);
  });
});

describe('encodePlantUmlText', () => {
  const samples = [
    '@startuml\nAlice -> Bob : hello\n@enduml',
    '@startuml\n@enduml',
    '@startuml\ntitle Üñíçødé — éèê\n@enduml',
    `@startuml\n${'A -> B\n'.repeat(500)}@enduml`,
  ];

  for (const [index, source] of samples.entries()) {
    it(`round-trips sample ${index + 1}`, () => {
      const encoded = encodePlantUmlText(source);
      const decoded = inflateRawSync(decodePlantUml(encoded)).toString('utf8');
      assert.equal(decoded, source);
    });
  }

  it('produces only URL-safe characters', () => {
    const encoded = encodePlantUmlText('@startuml\nA -> B\n@enduml');
    assert.match(encoded, /^[A-Za-z0-9_-]+$/u);
  });

  it('is deterministic', () => {
    const source = '@startuml\nA -> B\n@enduml';
    assert.equal(encodePlantUmlText(source), encodePlantUmlText(source));
  });

  it('compresses repetitive input well below its original size', () => {
    const source = `@startuml\n${'A -> B : hello\n'.repeat(200)}@enduml`;
    assert.ok(encodePlantUmlText(source).length < source.length / 4);
  });
});
