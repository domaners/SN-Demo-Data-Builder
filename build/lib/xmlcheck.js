'use strict';
// Minimal XML well-formedness check (balanced tags, quoted attributes, known entities).
// Enough to catch escaping mistakes in generated update sets without a dependency.

function checkWellFormed(xml, label) {
	const where = label ? ' in ' + label : '';
	const stack = [];
	let i = 0;
	const text = (chunk) => {
		const bad = /&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.exec(chunk);
		if (bad)
			throw new Error('Unescaped & at offset ' + (i + bad.index) + where);
	};
	while (i < xml.length) {
		const lt = xml.indexOf('<', i);
		if (lt < 0) {
			text(xml.slice(i));
			break;
		}
		text(xml.slice(i, lt));
		if (xml.startsWith('<?', lt)) {
			i = xml.indexOf('?>', lt) + 2;
			continue;
		}
		if (xml.startsWith('<!--', lt)) {
			i = xml.indexOf('-->', lt) + 3;
			continue;
		}
		if (xml.startsWith('<![CDATA[', lt)) {
			i = xml.indexOf(']]>', lt) + 3;
			continue;
		}
		const gt = xml.indexOf('>', lt);
		if (gt < 0)
			throw new Error('Unclosed tag at offset ' + lt + where);
		const tag = xml.slice(lt + 1, gt);
		if (tag.indexOf('<') >= 0)
			throw new Error('"<" inside tag at offset ' + lt + where);
		if (tag[0] === '/') {
			const name = tag.slice(1).trim();
			const open = stack.pop();
			if (open !== name)
				throw new Error('Mismatched </' + name + '> (expected </' + open + '>) at offset ' + lt + where);
		} else {
			const selfClosing = tag.endsWith('/');
			const m = /^([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+="[^"<]*")*)\s*\/?$/.exec(tag);
			if (!m)
				throw new Error('Malformed tag <' + tag.slice(0, 60) + '> at offset ' + lt + where);
			text(m[2]);
			if (!selfClosing)
				stack.push(m[1]);
		}
		i = gt + 1;
	}
	if (stack.length)
		throw new Error('Unclosed element(s): ' + stack.join(', ') + where);
}

module.exports = { checkWellFormed };
