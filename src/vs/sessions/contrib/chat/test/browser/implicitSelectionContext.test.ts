/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { Selection } from '../../../../../editor/common/core/selection.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { IChatRequestVariableEntry } from '../../../../../workbench/contrib/chat/common/attachments/chatVariableEntries.js';
import { getImplicitSelectionContext } from '../../browser/implicitSelectionContext.js';

suite('ImplicitSelectionContext', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('returns selection attachment for active editor selection', () => {
		const resource = URI.file('/repo/src/example.ts');
		const selection = new Selection(3, 2, 7, 5);
		const selectedText = 'const x = 42;';
		const editorService = new class extends mock<IEditorService>() {
			override activeTextEditorControl = {
				getModel: () => ({ uri: resource, getValueInRange: () => selectedText }),
				getSelection: () => selection,
			} as any;
		};

		const attachment = getImplicitSelectionContext(editorService, []);

		assert.ok(attachment);
		assert.strictEqual(attachment.kind, 'file');
		assert.strictEqual(attachment.id, 'vscode.implicit.selection');
		assert.strictEqual(attachment.name, 'example.ts');
		assert.deepStrictEqual(attachment.value, { uri: resource, range: selection });
		assert.strictEqual(attachment.modelDescription, selectedText);
	});

	test('does not duplicate an already attached selection', () => {
		const resource = URI.file('/repo/src/example.ts');
		const selection = new Selection(3, 2, 7, 5);
		const editorService = new class extends mock<IEditorService>() {
			override activeTextEditorControl = {
				getModel: () => ({ uri: resource, getValueInRange: () => '' }),
				getSelection: () => selection,
			} as any;
		};
		const existingAttachments: IChatRequestVariableEntry[] = [{
			kind: 'file',
			id: 'manual-selection',
			name: 'example.ts',
			value: { uri: resource, range: selection },
		}];

		const attachment = getImplicitSelectionContext(editorService, existingAttachments);

		assert.strictEqual(attachment, undefined);
	});
});
