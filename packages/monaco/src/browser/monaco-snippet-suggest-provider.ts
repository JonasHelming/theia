/********************************************************************************
 * Copyright (C) 2019 TypeFox and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as jsoncparser from 'jsonc-parser';
import { injectable, inject } from 'inversify';
import URI from '@theia/core/lib/common/uri';
import { FileSystem, FileSystemError } from '@theia/filesystem/lib/common';
import { CompletionTriggerKind } from '@theia/languages/lib/browser';

@injectable()
export class MonacoSnippetSuggestProvider implements monaco.languages.CompletionItemProvider {

    private static readonly _maxPrefix = 10000;

    @inject(FileSystem)
    protected readonly filesystem: FileSystem;

    protected readonly snippets = new Map<string, Snippet[]>();
    protected readonly pendingSnippets = new Map<string, Promise<void>[]>();

    async provideCompletionItems(model: monaco.editor.ITextModel, position: monaco.Position,
        context: monaco.languages.CompletionContext): Promise<monaco.languages.CompletionList | undefined> {

        // copied and modified from https://github.com/microsoft/vscode/blob/master/src/vs/workbench/contrib/snippets/browser/snippetCompletionProvider.ts
        if (position.column >= MonacoSnippetSuggestProvider._maxPrefix) {
            return undefined;
        }

        if (context.triggerKind === CompletionTriggerKind.TriggerCharacter && context.triggerCharacter === ' ') {
            // no snippets when suggestions have been triggered by space
            return undefined;
        }

        const languageId = model.getModeId(); // TODO: look up a language id at the position
        await this.loadSnippets(languageId);
        const snippetsForLanguage = this.snippets.get(languageId) || [];

        let suggestions: MonacoSnippetSuggestion[];
        const pos = { lineNumber: position.lineNumber, column: 1 };
        const lineOffsets: number[] = [];
        const linePrefixLow = model.getLineContent(position.lineNumber).substr(0, position.column - 1).toLowerCase();
        const endsInWhitespace = linePrefixLow.match(/\s$/);

        while (pos.column < position.column) {
            const word = model.getWordAtPosition(pos);
            if (word) {
                // at a word
                lineOffsets.push(word.startColumn - 1);
                pos.column = word.endColumn + 1;
                if (word.endColumn - 1 < linePrefixLow.length && !/\s/.test(linePrefixLow[word.endColumn - 1])) {
                    lineOffsets.push(word.endColumn - 1);
                }
            } else if (!/\s/.test(linePrefixLow[pos.column - 1])) {
                // at a none-whitespace character
                lineOffsets.push(pos.column - 1);
                pos.column += 1;
            } else {
                // always advance!
                pos.column += 1;
            }
        }

        const availableSnippets = new Set<Snippet>();
        snippetsForLanguage.forEach(availableSnippets.add, availableSnippets);
        suggestions = [];
        for (const start of lineOffsets) {
            availableSnippets.forEach(snippet => {
                if (this.isPatternInWord(linePrefixLow, start, linePrefixLow.length, snippet.prefix.toLowerCase(), 0, snippet.prefix.length)) {
                    suggestions.push(new MonacoSnippetSuggestion(snippet, monaco.Range.fromPositions(position.delta(0, -(linePrefixLow.length - start)), position)));
                    availableSnippets.delete(snippet);
                }
            });
        }
        if (endsInWhitespace || lineOffsets.length === 0) {
            // add remaing snippets when the current prefix ends in whitespace or when no
            // interesting positions have been found
            availableSnippets.forEach(snippet => {
                suggestions.push(new MonacoSnippetSuggestion(snippet, monaco.Range.fromPositions(position)));
            });
        }

        // dismbiguate suggestions with same labels
        suggestions.sort(MonacoSnippetSuggestion.compareByLabel);
        return { suggestions };
    }

    resolveCompletionItem(textModel: monaco.editor.ITextModel, position: monaco.Position, item: monaco.languages.CompletionItem): monaco.languages.CompletionItem {
        return item instanceof MonacoSnippetSuggestion ? item.resolve() : item;
    }

    protected async loadSnippets(scope: string): Promise<void> {
        const pending: Promise<void>[] = [];
        pending.push(...(this.pendingSnippets.get(scope) || []));
        pending.push(...(this.pendingSnippets.get('*') || []));
        if (pending.length) {
            await Promise.all(pending);
        }
    }

    fromURI(uri: string | URI, options: SnippetLoadOptions): Promise<void> {
        const pending = this.loadURI(uri, options);
        const { language } = options;
        const scopes = Array.isArray(language) ? language : !!language ? [language] : ['*'];
        for (const scope of scopes) {
            const pendingSnippets = this.pendingSnippets.get(scope) || [];
            pendingSnippets.push(pending);
            this.pendingSnippets.set(scope, pendingSnippets);
        }
        return pending;
    }
    /**
     * should NOT throw to prevent load erros on suggest
     */
    protected async loadURI(uri: string | URI, options: SnippetLoadOptions): Promise<void> {
        try {
            const { content } = await this.filesystem.resolveContent(uri.toString(), { encoding: 'utf-8' });
            const snippets = content && jsoncparser.parse(content, undefined, { disallowComments: false });
            this.fromJSON(snippets, options);
        } catch (e) {
            if (!FileSystemError.FileNotFound.is(e) && !FileSystemError.FileIsDirectory.is(e)) {
                console.error(e);
            }
        }
    }

    fromJSON(snippets: JsonSerializedSnippets | undefined, { language, source }: SnippetLoadOptions): void {
        this.parseSnippets(snippets, (name, snippet) => {
            let { prefix, body, description } = snippet;
            if (Array.isArray(body)) {
                body = body.join('\n');
            }
            if (typeof prefix !== 'string' || typeof body !== 'string') {
                return;
            }
            const scopes: string[] = [];
            if (language) {
                if (Array.isArray(language)) {
                    scopes.push(...language);
                } else {
                    scopes.push(language);
                }
            } else if (typeof snippet.scope === 'string') {
                for (const rawScope of snippet.scope.split(',')) {
                    const scope = rawScope.trim();
                    if (scope) {
                        scopes.push(scope);
                    }
                }
            }
            this.push({
                scopes,
                name,
                prefix,
                description,
                body,
                source
            });
        });
    }
    protected parseSnippets(snippets: JsonSerializedSnippets | undefined, accept: (name: string, snippet: JsonSerializedSnippet) => void): void {
        if (typeof snippets === 'object') {
            // tslint:disable-next-line:forin
            for (const name in snippets) {
                const scopeOrTemplate = snippets[name];
                if (JsonSerializedSnippet.is(scopeOrTemplate)) {
                    accept(name, scopeOrTemplate);
                } else {
                    this.parseSnippets(scopeOrTemplate, accept);
                }
            }
        }
    }

    push(...snippets: Snippet[]): void {
        for (const snippet of snippets) {
            for (const scope of snippet.scopes) {
                const languageSnippets = this.snippets.get(scope) || [];
                languageSnippets.push(snippet);
                this.snippets.set(scope, languageSnippets);
            }
        }
    }

    protected isPatternInWord(patternLow: string, patternPos: number, patternLen: number, wordLow: string, wordPos: number, wordLen: number): boolean {
        while (patternPos < patternLen && wordPos < wordLen) {
            if (patternLow[patternPos] === wordLow[wordPos]) {
                patternPos += 1;
            }
            wordPos += 1;
        }
        return patternPos === patternLen; // pattern must be exhausted
    }

}

export interface SnippetLoadOptions {
    language?: string | string[]
    source: string
}

export interface JsonSerializedSnippets {
    [name: string]: JsonSerializedSnippet | { [name: string]: JsonSerializedSnippet };
}
export interface JsonSerializedSnippet {
    body: string | string[];
    scope: string;
    prefix: string;
    description: string;
}
export namespace JsonSerializedSnippet {
    export function is(obj: Object | undefined): obj is JsonSerializedSnippet {
        return typeof obj === 'object' && 'body' in obj && 'prefix' in obj;
    }
}

export interface Snippet {
    readonly scopes: string[]
    readonly name: string
    readonly prefix: string
    readonly description: string
    readonly body: string
    readonly source: string
}

export class MonacoSnippetSuggestion implements monaco.languages.CompletionItem {

    readonly label: string;
    readonly detail: string;
    readonly sortText: string;
    readonly noAutoAccept = true;
    readonly kind = monaco.languages.CompletionItemKind.Snippet;
    readonly insertTextRules = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;

    insertText: string;
    documentation?: monaco.IMarkdownString;

    constructor(
        protected readonly snippet: Snippet,
        readonly range: monaco.Range
    ) {
        this.label = snippet.prefix;
        this.detail = `${snippet.description || snippet.name} (${snippet.source})`;
        this.insertText = snippet.body;
        this.sortText = `z-${snippet.prefix}`;
        this.range = range;
    }

    protected resolved = false;
    resolve(): MonacoSnippetSuggestion {
        if (!this.resolved) {
            const codeSnippet = new monaco.snippetParser.SnippetParser().parse(this.snippet.body).toString();
            this.documentation = { value: '```\n' + codeSnippet + '```' };
            this.resolved = true;
        }
        return this;
    }

    static compareByLabel(a: MonacoSnippetSuggestion, b: MonacoSnippetSuggestion): number {
        return a.label > b.label ? 1 : a.label < b.label ? -1 : 0;
    }

}
