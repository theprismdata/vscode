/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IRange } from '../../../../editor/common/core/range.js';
import { IStringDictionary } from '../../../../base/common/collections.js';

export const ILanguageModelsConfigurationService = createDecorator<ILanguageModelsConfigurationService>('ILanguageModelsConfigurationService');

export interface ConfigureLanguageModelsOptions {
	group: ILanguageModelsProviderGroup;
	snippet?: string;
}

export interface ILanguageModelsConfigurationService {
	readonly _serviceBrand: undefined;

	readonly configurationFile: URI;

	readonly onDidChangeLanguageModelGroups: Event<readonly ILanguageModelsProviderGroup[]>;

	getLanguageModelsProviderGroups(): readonly ILanguageModelsProviderGroup[];

	addLanguageModelsProviderGroup(languageModelsProviderGroup: ILanguageModelsProviderGroup): Promise<ILanguageModelsProviderGroup>;

	updateLanguageModelsProviderGroup(from: ILanguageModelsProviderGroup, to: ILanguageModelsProviderGroup): Promise<ILanguageModelsProviderGroup>;

	removeLanguageModelsProviderGroup(languageModelGroup: ILanguageModelsProviderGroup): Promise<void>;

	configureLanguageModels(options?: ConfigureLanguageModelsOptions): Promise<void>;
}

export interface ILanguageModelsProviderGroup extends IStringDictionary<unknown> {
	readonly name: string;
	readonly vendor: string;
	readonly range?: IRange;

	// Cursor Style UI - Custom Provider Fields
	readonly id?: string;
	readonly displayName?: string;
	readonly baseUrl?: string;
	/** API key - stored as a secret reference (decoded at runtime via Secret Storage). */
	readonly apiKey?: string;
	readonly defaultModel?: string;
	readonly models?: string[];
	/**
	 * 엔드포인트 버전 (기본값: 'v3')
	 * vLLM 연동 시 endpoint가 v1과 v3가 다른 경우가 있습니다.
	 * 현재 버전 기준은 v3이므로, LLM API 호출 시 v3 엔드포인트 규격을 준수해야 합니다.
	 */
	readonly endpointVersion?: 'v1' | 'v3';
}
