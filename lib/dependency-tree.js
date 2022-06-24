/* eslint-disable no-sync */
'use strict';

const precinct = require('precinct');
const path = require('path');
const fs = require('fs');
const cabinet = require('./filing-cabinet');

module.exports = async function (files, options) {
	const config = {
		directory: options.directory || options.root,
		visited: options.visited || {},
		nonExistent: options.nonExistent || [],
		requireConfig: options.config || options.requireConfig,
		webpackConfig: options.webpackConfig ? await loadWebpackConfig(options.webpackConfig) : undefined,
		nodeModulesConfig: options.nodeModulesConfig,
		detectiveConfig: options.detective || options.detectiveConfig || {},
		tsConfig: options.tsConfig,
		noTypeDefinitions: options.noTypeDefinitions,
		filter: options.filter
	};

	if (typeof config.tsConfig === 'string') {
		const ts = require('typescript');
		const tsParsedConfig = ts.readJsonConfigFile(config.tsConfig, ts.sys.readFile);
		const obj = ts.parseJsonSourceFileConfigFileContent(tsParsedConfig, ts.sys, path.dirname(config.tsConfig));
		config.tsConfig = obj.raw;
	}

	await Promise.all(files.map(async (file) => {
		if (fs.existsSync(file)) {
			await traverse({
				...config,
				filename: path.resolve(file)
			});
		}
	}));

	const deduped = new Set(config.nonExistent);
	config.nonExistent.length = 0;
	config.nonExistent.push(...deduped);

	return config.visited;
};

async function getDependencies(config) {
	let dependencies;
	const precinctOptions = config.detectiveConfig;
	precinctOptions.includeCore = false;

	try {
		dependencies = precinct.paperwork(config.filename, precinctOptions);
	} catch (e) {
		return [];
	}

	const resolvedDependencies = [];

	await Promise.all(dependencies.map(async (dependency) => {
		const result = cabinet({
			dependency,
			filename: config.filename,
			directory: config.directory,
			ast: precinct.ast,
			config: config.requireConfig,
			webpackConfig: config.webpackConfig,
			nodeModulesConfig: config.nodeModulesConfig,
			tsConfig: config.tsConfig,
			noTypeDefinitions: config.noTypeDefinitions
		});

		if (!result) {
			config.nonExistent.push(dependency);

			return;
		}

		const exists = fs.existsSync(result);

		if (!exists) {
			config.nonExistent.push(dependency);

			return;
		}

		resolvedDependencies.push(result);
	}));

	return resolvedDependencies;
}

async function loadWebpackConfig(webpackConfig) {
	webpackConfig = path.resolve(webpackConfig);

	let {default: loadedConfig} = await import(webpackConfig);

	if (typeof loadedConfig === 'function') {
		loadedConfig = await loadedConfig();
	}

	if (Array.isArray(loadedConfig)) {
		loadedConfig = loadedConfig[0];
	}

	return loadedConfig;
}

async function traverse(config) {
	if (!(config.filename in config.visited)) {
		config.visited[config.filename] = getDependencies(config).then(async (dependencies) => {
			if (config.filter) {
				dependencies = dependencies.filter((filePath) => config.filter(filePath, config.filename));
			}

			await Promise.all(dependencies.filter((dependency) => !(dependency in config.visited)).map((dependency) => traverse(
				{
					...config,
					filename: dependency
				}
			)));

			return dependencies;
		});

		config.visited[config.filename] = await config.visited[config.filename];
	}

	return config.visited[config.filename];
}
