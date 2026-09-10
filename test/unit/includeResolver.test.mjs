/**
 * Tests for `!include` resolution.
 *
 * The containment tests are the important ones: they are what stands between a
 * diagram file and the rest of the user's disk.
 */

import assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { isContained, resolveIncludes, selectSection } from '../../out/extension/include/includeResolver.js';

const ROOT = path.resolve('/workspace/project');
const DOCUMENT = path.join(ROOT, 'diagrams', 'main.puml');

/** Builds a reader over an in-memory file system keyed by absolute path. */
function reader(files) {
  const normalised = new Map(
    Object.entries(files).map(([key, value]) => [path.resolve(key).toLowerCase(), value]),
  );
  return async (absolutePath) => normalised.get(path.resolve(absolutePath).toLowerCase());
}

function options(overrides = {}) {
  return {
    documentPath: DOCUMENT,
    allowedRoots: [ROOT],
    searchPaths: [],
    maxDepth: 10,
    allowOutsideRoots: false,
    maxTotalChars: 1_000_000,
    ...overrides,
  };
}

describe('resolveIncludes / resolution', () => {
  it('inlines a sibling file and strips its delimiters', async () => {
    const files = {
      [path.join(ROOT, 'diagrams', 'common.puml')]: '@startuml\nskinparam shadowing false\n@enduml',
    };
    const result = await resolveIncludes(
      '@startuml\n!include common.puml\nA -> B\n@enduml',
      options(),
      reader(files),
    );

    assert.match(result.text, /skinparam shadowing false/u);
    assert.doesNotMatch(result.text, /@startuml\n@startuml/u);
    assert.equal(result.problems.length, 0);
    assert.equal(result.includedFiles.length, 1);
  });

  it('reports each included file so the caller can watch it', async () => {
    const files = { [path.join(ROOT, 'diagrams', 'a.puml')]: 'A -> B' };
    const result = await resolveIncludes('!include a.puml', options(), reader(files));
    assert.equal(result.includedFiles.length, 1);
    assert.match(result.includedFiles[0], /a\.puml$/u);
  });

  it('searches the configured include paths for a relative target', async () => {
    const shared = path.join(ROOT, 'shared');
    const files = { [path.join(shared, 'style.puml')]: 'skinparam monochrome true' };
    const result = await resolveIncludes(
      '!include style.puml',
      options({ searchPaths: [shared], allowedRoots: [ROOT, shared] }),
      reader(files),
    );
    assert.match(result.text, /monochrome true/u);
  });

  it('handles the include_once, includesub and includedef spellings', async () => {
    const files = { [path.join(ROOT, 'diagrams', 'x.puml')]: 'note over A : hi' };
    for (const keyword of ['include', 'include_once', 'include_many', 'includedef']) {
      const result = await resolveIncludes(`!${keyword} x.puml`, options(), reader(files));
      assert.match(result.text, /note over A/u, `keyword ${keyword} should resolve`);
    }
  });

  it('inlines an include_once target only the first time', async () => {
    const files = { [path.join(ROOT, 'diagrams', 'x.puml')]: 'skinparam dpi 100' };
    const result = await resolveIncludes(
      '!include_once x.puml\n!include_once x.puml',
      options(),
      reader(files),
    );
    const occurrences = result.text.split('skinparam dpi 100').length - 1;
    assert.equal(occurrences, 1);
  });

  it('passes standard-library includes through untouched', async () => {
    const result = await resolveIncludes('!include <C4/C4_Container>', options(), reader({}));
    assert.match(result.text, /!include <C4\/C4_Container>/u);
    assert.equal(result.problems.length, 0);
  });
});

describe('resolveIncludes / containment', () => {
  it('refuses to read outside the allowed roots', async () => {
    const outside = path.resolve('/etc/passwd');
    const result = await resolveIncludes(
      `!include ${outside}`,
      options(),
      reader({ [outside]: 'root:x:0:0' }),
    );
    assert.doesNotMatch(result.text, /root:x/u);
    assert.equal(result.problems.length, 1);
    assert.equal(result.problems[0].severity, 'error');
  });

  it('refuses a traversal that climbs out of the workspace', async () => {
    const outside = path.resolve('/secrets.txt');
    const result = await resolveIncludes(
      '!include ../../../secrets.txt',
      options(),
      reader({ [outside]: 'TOP SECRET' }),
    );
    assert.doesNotMatch(result.text, /TOP SECRET/u);
    assert.equal(result.problems.length, 1);
  });

  it('allows an outside path only when explicitly opted in', async () => {
    const outside = path.resolve('/elsewhere/shared.puml');
    const result = await resolveIncludes(
      `!include ${outside}`,
      options({ allowOutsideRoots: true }),
      reader({ [outside]: 'skinparam handwritten true' }),
    );
    assert.match(result.text, /handwritten true/u);
  });

  it('never fetches a remote include and says so', async () => {
    const result = await resolveIncludes(
      '!includeurl https://evil.example/payload.puml',
      options(),
      reader({}),
    );
    assert.doesNotMatch(result.text, /!includeurl/u);
    assert.equal(result.problems.length, 1);
    assert.equal(result.problems[0].severity, 'warning');
    assert.match(result.problems[0].reason, /not fetched/iu);
  });

  it('treats a URL passed to plain !include as remote too', async () => {
    const result = await resolveIncludes(
      '!include http://evil.example/payload.puml',
      options(),
      reader({}),
    );
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0].reason, /not fetched/iu);
  });

  it('neutralises PlantUML syntax in a rejected target before echoing it', async () => {
    const result = await resolveIncludes(
      '!include ../@startuml!evil.puml',
      options(),
      reader({}),
    );
    assert.doesNotMatch(result.text, /@startuml!evil/u);
  });
});

describe('resolveIncludes / limits', () => {
  it('detects a direct cycle', async () => {
    const a = path.join(ROOT, 'diagrams', 'a.puml');
    const result = await resolveIncludes(
      '!include a.puml',
      options({ documentPath: a }),
      reader({ [a]: '!include a.puml' }),
    );
    assert.ok(result.problems.some((problem) => /circular/iu.test(problem.reason)));
  });

  it('stops at the configured nesting depth', async () => {
    const files = {};
    for (let i = 0; i < 10; i++) {
      files[path.join(ROOT, 'diagrams', `f${i}.puml`)] = `!include f${i + 1}.puml`;
    }
    files[path.join(ROOT, 'diagrams', 'f10.puml')] = 'A -> B';

    const result = await resolveIncludes(
      '!include f0.puml',
      options({ maxDepth: 3 }),
      reader(files),
    );
    assert.ok(result.problems.some((problem) => /deeper than 3/iu.test(problem.reason)));
  });

  it('stops once the total inlined size exceeds the budget', async () => {
    const files = { [path.join(ROOT, 'diagrams', 'big.puml')]: 'x'.repeat(5000) };
    const result = await resolveIncludes(
      '!include big.puml',
      options({ maxTotalChars: 100 }),
      reader(files),
    );
    assert.ok(result.problems.some((problem) => /size limit/iu.test(problem.reason)));
  });

  it('reports an unreadable file without failing the whole render', async () => {
    const result = await resolveIncludes(
      '@startuml\n!include missing.puml\nA -> B\n@enduml',
      options(),
      reader({}),
    );
    assert.match(result.text, /A -> B/u, 'the rest of the diagram should survive');
    assert.equal(result.problems.length, 1);
  });
});

describe('resolveIncludes / line mapping', () => {
  it('maps lines after an include back to their original position', async () => {
    const files = { [path.join(ROOT, 'diagrams', 'x.puml')]: 'line1\nline2\nline3' };
    const source = ['@startuml', '!include x.puml', 'A -> B', '@enduml'].join('\n');
    const result = await resolveIncludes(source, options(), reader(files));

    const lines = result.text.split('\n');
    const renderedIndex = lines.indexOf('A -> B');
    assert.ok(renderedIndex > 2, 'the include should have shifted the line down');
    assert.equal(result.lineMap[renderedIndex], 2, 'it should map back to original line 2');
  });

  it('attributes lines from an included file to the directive that pulled them in', async () => {
    const files = { [path.join(ROOT, 'diagrams', 'x.puml')]: 'included' };
    const result = await resolveIncludes(
      ['@startuml', '!include x.puml', '@enduml'].join('\n'),
      options(),
      reader(files),
    );
    const index = result.text.split('\n').indexOf('included');
    assert.equal(result.lineMap[index], 1);
  });

  it('maps every line one-to-one when there is no include', async () => {
    const source = ['@startuml', 'A -> B', 'B -> C', '@enduml'].join('\n');
    const result = await resolveIncludes(source, options(), reader({}));
    assert.deepEqual([...result.lineMap], [0, 1, 2, 3]);
  });
});

describe('selectSection', () => {
  it('returns the whole file without delimiters by default', () => {
    assert.equal(selectSection('@startuml\nbody\n@enduml', undefined), 'body');
  });

  it('selects a numbered diagram block', () => {
    const content = '@startuml\nfirst\n@enduml\n@startuml\nsecond\n@enduml';
    assert.equal(selectSection(content, '1'), 'second');
  });

  it('selects a named sub-section', () => {
    const content = ['!startsub ALPHA', 'inside', '!endsub', 'outside'].join('\n');
    assert.equal(selectSection(content, 'ALPHA'), 'inside');
  });

  it('returns undefined for a section that does not exist', () => {
    assert.equal(selectSection('body', 'MISSING'), undefined);
    assert.equal(selectSection('@startuml\nx\n@enduml', '9'), undefined);
  });

  it('does not let a selector inject a regular expression', () => {
    const content = ['!startsub A.C', 'inside', '!endsub'].join('\n');
    assert.equal(selectSection(content, 'ABC'), undefined);
    assert.equal(selectSection(content, 'A.C'), 'inside');
  });
});

describe('isContained', () => {
  it('accepts a path inside a root', () => {
    assert.equal(isContained(path.resolve('/a/b/c.txt'), [path.resolve('/a')]), true);
  });

  it('accepts the root itself', () => {
    assert.equal(isContained(path.resolve('/a'), [path.resolve('/a')]), true);
  });

  it('rejects a sibling whose name merely starts with the root', () => {
    assert.equal(isContained(path.resolve('/ab/c.txt'), [path.resolve('/a')]), false);
  });

  it('rejects a path outside every root', () => {
    assert.equal(isContained(path.resolve('/x/y.txt'), [path.resolve('/a'), path.resolve('/b')]), false);
  });
});
