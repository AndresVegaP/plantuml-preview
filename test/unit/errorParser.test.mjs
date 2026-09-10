/**
 * Tests for recovering a usable message and line number from backend output.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { parseErrorImage, parseErrorText } from '../../out/extension/render/errorParser.js';

describe('parseErrorText', () => {
  it('returns undefined for empty output', () => {
    assert.equal(parseErrorText(''), undefined);
    assert.equal(parseErrorText('   \n  '), undefined);
  });

  it('converts PlantUML’s 1-based line number to a 0-based one', () => {
    const result = parseErrorText('Error line 5 in file: -\nSome diagram description contains errors');
    assert.equal(result.line, 4);
  });

  it('recognises the other line-number spellings', () => {
    assert.equal(parseErrorText('error line 3').line, 2);
    assert.equal(parseErrorText('at line 9').line, 8);
    assert.equal(parseErrorText('line 12: unexpected token').line, 11);
    assert.equal(parseErrorText('failed (line 7)').line, 6);
  });

  it('uses the first meaningful line as the message', () => {
    const result = parseErrorText('\n\nSyntax error at "foo"\ncontext line\n');
    assert.equal(result.message, 'Syntax error at "foo"');
  });

  it('omits the line when none is named', () => {
    const result = parseErrorText('Something went wrong');
    assert.equal(result.line, undefined);
    assert.equal(result.message, 'Something went wrong');
  });

  it('ignores a line number of zero, which PlantUML never emits', () => {
    assert.equal(parseErrorText('error line 0').line, undefined);
  });
});

describe('parseErrorImage', () => {
  it('ignores an ordinary diagram', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Alice</text></svg>';
    assert.equal(parseErrorImage(svg), undefined);
  });

  it('detects PlantUML’s error report by its location header', () => {
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg">',
      '<text>[From string (line 4) ]</text>',
      '<text>@startuml</text>',
      '<text> Syntax Error?</text>',
      '</svg>',
    ].join('');
    assert.deepEqual(parseErrorImage(svg), { message: 'Syntax Error?', line: 3 });
  });

  it('detects a missing Graphviz message', () => {
    // The lines plantuml.jar 1.2026.8 prints when dot is missing. The jar would
    // not draw them on the machine the other fixtures came from, because it
    // falls back to a Graphviz of its own there, so this image is written by hand.
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg"><g>',
      '<text>Dot Executable: /usr/bin/dot</text>',
      '<text>File /usr/bin/dot does not exist</text>',
      '<text>Cannot find Graphviz. You should try</text>',
      '<text>java -jar plantuml.jar -testdot</text>',
      '</g></svg>',
    ].join('');
    assert.deepEqual(parseErrorImage(svg), { message: 'Dot Executable: /usr/bin/dot' });
  });

  it('decodes entities in the recovered text', () => {
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg">',
      '<text>An error has occurred : java.lang.IllegalStateException: unexpected &lt;tag&gt; &amp; more</text>',
      '</svg>',
    ].join('');
    const result = parseErrorImage(svg);
    assert.match(result.message, /unexpected <tag> & more/u);
  });

  it('reads text out of tspan children too', () => {
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg">',
      '<text><tspan>[From string (line 2) ]</tspan></text>',
      '<text><tspan> Syntax Error?</tspan></text>',
      '</svg>',
    ].join('');
    const result = parseErrorImage(svg);
    assert.equal(result.line, 1);
  });
});

/**
 * Reads an image captured from the built-in engine.
 *
 * Each fixture is the sanitised SVG the preview webview posts back to the host,
 * produced by @plantuml/core 1.2026.8 in the engine harness (`npm run harness`).
 * They are real output rather than hand-written markup, so these tests break if
 * the engine ever changes how it reports an error. The PlantUML source behind
 * each one is quoted in its test, one line per ` / `.
 */
function engineImage(name) {
  return readFileSync(new URL(`./fixtures/${name}.svg`, import.meta.url), 'utf8').trimEnd();
}

describe('parseErrorImage on images from the built-in engine', () => {
  it('reports a syntax error on the line PlantUML names', () => {
    // @startuml / Alice -> Bob / this is bad @@@ / @enduml
    assert.deepEqual(parseErrorImage(engineImage('engine-syntax-error')), {
      message: 'Syntax Error? (Assumed diagram type: sequence)',
      line: 2,
    });
  });

  it('takes the line from the report header, not from echoed source that mentions a line', () => {
    // @startuml / Alice -> Bob : retry at line 7 / this is bad @@@ / @enduml
    const result = parseErrorImage(engineImage('engine-syntax-error-echoing-a-line-number'));
    assert.equal(result?.line, 2);
  });

  it('recognises errors other than "Syntax Error?"', () => {
    // @startuml / !include <tupadr3/common> / Alice -> Bob / @enduml
    assert.deepEqual(parseErrorImage(engineImage('engine-fatal-parsing-error')), {
      message: 'Fatal parsing error',
      line: 1,
    });
  });

  it('ignores a diagram whose own label says "Syntax Error?"', () => {
    // @startuml / Client -> User : Syntax Error? / @enduml
    assert.equal(parseErrorImage(engineImage('engine-diagram-labelled-syntax-error')), undefined);
  });

  it('ignores a diagram whose own label says "An error has occurred"', () => {
    // @startuml / Server --> Client : An error has occurred / @enduml
    assert.equal(
      parseErrorImage(engineImage('engine-diagram-labelled-an-error-has-occurred')),
      undefined,
    );
  });

  it('ignores a diagram that is nothing but a title saying "An error has occurred!"', () => {
    // @startuml / title An error has occurred! / @enduml
    assert.equal(
      parseErrorImage(engineImage('engine-diagram-titled-an-error-has-occurred')),
      undefined,
    );
  });

  it('reports the page the engine draws when Graphviz crashes', () => {
    // @startuml / class Order / class Customer / Customer "1" --> "*" Order / @enduml
    // rendered with Viz.instance() swapped for one whose renderString throws.
    assert.deepEqual(parseErrorImage(engineImage('engine-graphviz-crash')), {
      message: 'An error has occurred!',
    });
  });
});

/**
 * Reads an image captured from plantuml.jar, which is also what a PlantUML
 * server sends back.
 *
 * Each fixture is the raw SVG the `jar` backend receives: the stdout of
 * plantuml-mit-1.2026.8.jar run with JarRenderer's arguments under Java 21, with
 * `-Duser.language=en -Duser.country=US` so that a crash report does not record
 * the locale of the machine that captured it.
 */
function jarImage(name) {
  return readFileSync(new URL(`./fixtures/${name}.svg`, import.meta.url), 'utf8').trimEnd();
}

describe('parseErrorImage on images from plantuml.jar', () => {
  it('reports PlantUML’s crash report', () => {
    // @startuml / !pragma teoz true / Alice -> Bob : a / & Bob -> Alice : b / & Alice -> Alice : c / @enduml
    assert.deepEqual(parseErrorImage(jarImage('jar-crash-report')), {
      message: 'An error has occurred : java.lang.IllegalStateException: Infinite Loop?',
    });
  });

  it('ignores a diagram whose own label says "An error has occurred"', () => {
    // @startuml / Server --> Client : An error has occurred / @enduml
    assert.equal(parseErrorImage(jarImage('jar-diagram-labelled-an-error-has-occurred')), undefined);
  });
});
