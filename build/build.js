#!/usr/bin/env node
'use strict';
// Builds dist/ddb-<version>.xml, an update set containing the whole scoped app.
//   node build/build.js          write the file
//   node build/build.js --check  fail if the committed file is out of date

const fs = require('fs');
const path = require('path');
const { loadApp, ROOT } = require('./lib/source');
const { buildUpdateSet } = require('./lib/updateset');
const { checkWellFormed } = require('./lib/xmlcheck');

function main() {
	const check = process.argv.indexOf('--check') >= 0;
	const src = loadApp();
	const result = buildUpdateSet(src);
	checkWellFormed(result.xml);
	result.updates.forEach((u) => checkWellFormed(u.payload, u.name));

	const file = path.join(ROOT, 'dist', 'ddb-' + src.app.version + '.xml');
	const rel = path.relative(ROOT, file);
	if (check) {
		const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
		if (current !== result.xml) {
			console.error(rel + ' is out of date. Run: npm run build');
			process.exit(1);
		}
		console.log(rel + ' is up to date (' + result.updates.length + ' updates).');
		return;
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, result.xml);
	console.log('Wrote ' + rel + ' (' + result.updates.length + ' updates, ' + Math.round(result.xml.length / 1024) + ' KB).');
}

main();
