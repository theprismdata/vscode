/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename, isEqual } from '../../../../base/common/resources.js';
import { Range } from '../../../../editor/common/core/range.js';
import { isLocation } from '../../../../editor/common/languages.js';
import { isITextModel } from '../../../../editor/common/model.js';
import { IChatRequestVariableEntry } from '../../../../workbench/contrib/chat/common/attachments/chatVariableEntries.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';

export function getImplicitSelectionContext(
	editorService: IEditorService,
	existingAttachments: readonly IChatRequestVariableEntry[],
): IChatRequestVariableEntry | undefined {
	const activeEditor = editorService.activeTextEditorControl;
	if (!activeEditor) {
		return undefined;
	}

	const model = activeEditor.getModel();
	const selection = activeEditor.getSelection();
	if (!model || !isITextModel(model) || !selection || selection.isEmpty()) {
		return undefined;
	}

	const alreadyAttached = existingAttachments.some(attachment =>
		attachment.kind === 'file'
		&& isLocation(attachment.value)
		&& isEqual(attachment.value.uri, model.uri)
		&& Range.equalsRange(attachment.value.range, selection)
	);
	if (alreadyAttached) {
		return undefined;
	}

	const selectedText = model.getValueInRange(selection);

	return {
		kind: 'file',
		id: 'vscode.implicit.selection',
		name: basename(model.uri),
		value: {
			uri: model.uri,
			range: selection,
		},
		modelDescription: selectedText || undefined,
	};
}
