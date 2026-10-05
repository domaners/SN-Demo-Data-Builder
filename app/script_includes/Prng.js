/**
 * Seeded pseudo-random number generator (sfc32 seeded by cyrb128).
 *
 * Expansion must be reproducible: the same scenario seed always yields the same users,
 * hostnames and ticket timings. Each sub-generator derives its own stream with
 * fork(label), so adding a department does not reshuffle every other choice.
 *
 * @access package_private
 */
var Prng = Class.create();

Prng.imul = function (a, b) {
	if (typeof Math.imul === 'function')
		return Math.imul(a, b);
	const ah = (a >>> 16) & 0xffff;
	const al = a & 0xffff;
	const bh = (b >>> 16) & 0xffff;
	const bl = b & 0xffff;
	return ((al * bl) + (((ah * bl + al * bh) << 16) >>> 0)) | 0;
};

/** cyrb128 string hash -> four 32-bit words. */
Prng.hash = function (str) {
	let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
	const imul = Prng.imul;
	str = String(str);
	for (let i = 0; i < str.length; i++) {
		const k = str.charCodeAt(i);
		h1 = h2 ^ imul(h1 ^ k, 597399067);
		h2 = h3 ^ imul(h2 ^ k, 2869860233);
		h3 = h4 ^ imul(h3 ^ k, 951274213);
		h4 = h1 ^ imul(h4 ^ k, 2716044179);
	}
	h1 = imul(h3 ^ (h1 >>> 18), 597399067);
	h2 = imul(h4 ^ (h2 >>> 22), 2869860233);
	h3 = imul(h1 ^ (h3 >>> 17), 951274213);
	h4 = imul(h2 ^ (h4 >>> 19), 2716044179);
	h1 ^= (h2 ^ h3 ^ h4);
	h2 ^= h1;
	h3 ^= h1;
	h4 ^= h1;
	return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
};

Prng.prototype = {
	initialize: function (seed) {
		this.seed = String(seed);
		const s = Prng.hash(this.seed);
		this.a = s[0];
		this.b = s[1];
		this.c = s[2];
		this.d = s[3];
		// Warm up so similar seeds diverge quickly.
		for (let i = 0; i < 12; i++)
			this.nextUint32();
	},

	nextUint32: function () {
		this.a >>>= 0; this.b >>>= 0; this.c >>>= 0; this.d >>>= 0;
		let t = (this.a + this.b) | 0;
		this.a = this.b ^ (this.b >>> 9);
		this.b = (this.c + (this.c << 3)) | 0;
		this.c = (this.c << 21) | (this.c >>> 11);
		this.d = (this.d + 1) | 0;
		t = (t + this.d) | 0;
		this.c = (this.c + t) | 0;
		return t >>> 0;
	},

	/** Float in [0, 1). */
	next: function () {
		return this.nextUint32() / 4294967296;
	},

	/** Integer in [min, max] inclusive. */
	int: function (min, max) {
		return min + Math.floor(this.next() * (max - min + 1));
	},

	bool: function (probability) {
		return this.next() < (probability === undefined ? 0.5 : probability);
	},

	pick: function (list) {
		if (!list || !list.length)
			return undefined;
		return list[Math.floor(this.next() * list.length)];
	},

	/** Pick from items using weightFn(item) -> non-negative number. */
	weighted: function (items, weightFn) {
		let total = 0;
		const weights = [];
		for (let i = 0; i < items.length; i++) {
			const w = Math.max(0, Number(weightFn(items[i])) || 0);
			weights.push(w);
			total += w;
		}
		if (total <= 0)
			return this.pick(items);
		let r = this.next() * total;
		for (let j = 0; j < items.length; j++) {
			r -= weights[j];
			if (r < 0)
				return items[j];
		}
		return items[items.length - 1];
	},

	shuffle: function (list) {
		const out = list.slice();
		for (let i = out.length - 1; i > 0; i--) {
			const j = Math.floor(this.next() * (i + 1));
			const tmp = out[i];
			out[i] = out[j];
			out[j] = tmp;
		}
		return out;
	},

	/** RFC 4122 shaped (version 4 bits) GUID string, deterministic for this stream. */
	uuid: function () {
		const hex = [];
		for (let i = 0; i < 4; i++)
			hex.push(('00000000' + this.nextUint32().toString(16)).slice(-8));
		const h = hex.join('');
		const variant = ((parseInt(h.charAt(16), 16) & 0x3) | 0x8).toString(16);
		return h.substr(0, 8) + '-' + h.substr(8, 4) + '-4' + h.substr(13, 3) + '-' +
			variant + h.substr(17, 3) + '-' + h.substr(20, 12);
	},

	/** Independent child stream; same label always gives the same child. */
	fork: function (label) {
		return new Prng(this.seed + '/' + label);
	},

	type: 'Prng'
};
