/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { IChatSessionsService } from '../../../../../workbench/contrib/chat/common/chatSessionsService.js';
import { LocalNewSession } from '../../browser/newSession.js';

suite('LocalNewSession', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('preserves worktree isolation and clears branch when repository changes', () => {
		const instantiationService = new TestInstantiationService();
		const notifiedOptions: { optionId: string; value: string }[] = [];

		instantiationService.stub(IChatSessionsService, new class extends mock<IChatSessionsService>() {
			override async notifySessionOptionsChange(_sessionResource: URI, changes: { optionId: string; value: string }[]): Promise<void> {
				notifiedOptions.push(...changes);
			}
		});
		instantiationService.stub(ILogService, new NullLogService());

		const session = instantiationService.createInstance(
			LocalNewSession,
			URI.parse('chat://session'),
			URI.file('/repo-a'),
		);
		try {
			session.setIsolationMode('worktree');
			session.setBranch('main');

			session.setRepoUri(URI.file('/repo-b'));

			assert.strictEqual(session.isolationMode, 'worktree');
			assert.strictEqual(session.branch, undefined);
			assert.strictEqual(session.disabled, true);
			assert.deepStrictEqual(notifiedOptions.map(change => change.optionId), ['repository', 'branch', 'branch', 'repository']);
			assert.deepStrictEqual(notifiedOptions.at(-2), { optionId: 'branch', value: '' });
			assert.deepStrictEqual(notifiedOptions.at(-1), { optionId: 'repository', value: '/repo-b' });
		} finally {
			session.dispose();
		}
	});
});
