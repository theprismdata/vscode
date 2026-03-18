/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Range } from '../../../../editor/common/core/range.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ICodeMapperRequest, ICodeMapperResponse, ICodeMapperResult, ICodeMapperService } from '../common/editing/chatCodeMapperService.js';

/**
 * A simple built-in Code Mapper provider that replaces the entire file content
 * with the code block from the chat response. This enables the "Apply" button
 * on code blocks when no external provider (e.g. Copilot) is available.
 */
class SimpleCodeMapperContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.simpleCodeMapper';

	constructor(
		@ICodeMapperService codeMapperService: ICodeMapperService,
		@ITextModelService private readonly _textModelService: ITextModelService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		this._register(codeMapperService.registerCodeMapperProvider(0, {
			displayName: 'IntelliCen',
			mapCode: (request, response, token) => this._mapCode(request, response, token),
		}));

		this._logService.trace('[SimpleCodeMapper] Registered simple code mapper provider');
	}

	private async _mapCode(
		request: ICodeMapperRequest,
		response: ICodeMapperResponse,
		token: CancellationToken,
	): Promise<ICodeMapperResult | undefined> {

		for (const codeBlock of request.codeBlocks) {
			if (token.isCancellationRequested) {
				return undefined;
			}

			try {
				const ref = await this._textModelService.createModelReference(codeBlock.resource);
				try {
					const model = ref.object.textEditorModel;
					const fullRange = model.getFullModelRange();
					response.textEdit(codeBlock.resource, [{
						range: Range.lift(fullRange),
						text: codeBlock.code,
					}]);
				} finally {
					ref.dispose();
				}
			} catch (err) {
				this._logService.warn('[SimpleCodeMapper] Failed to map code block', err);
				return { errorMessage: `Failed to apply code: ${err}` };
			}
		}

		return undefined;
	}
}

registerWorkbenchContribution2(
	SimpleCodeMapperContribution.ID,
	SimpleCodeMapperContribution,
	WorkbenchPhase.AfterRestored,
);
