// JavaScript Unpacker – because some scripts like to wrap themselves in tiny socks
// the scraper calls this when it finds p.a.c.k.e.r nonsense in a Kwik player

interface Dictionary {
  [key: string]: number;
}

// helper that can read numbers in any alphabet you can imagine (radix > 36)
class UnBase {
  private readonly radix: number;
  private readonly alpha62 =
    "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  private readonly alpha95 =
    ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';
  private alphabet = "";
  private dictionary: Dictionary = {};

  constructor(radix: number) {
    this.radix = radix;

    if (radix > 36) {
      if (radix < 62) this.alphabet = this.alpha62.substring(0, radix);
      else if (radix === 62) this.alphabet = this.alpha62;
      else if (radix < 95) this.alphabet = this.alpha95.substring(0, radix);
      else if (radix === 95) this.alphabet = this.alpha95;

      for (let i = 0; i < this.alphabet.length; i++) {
        this.dictionary[this.alphabet.charAt(i)] = i;
      }
    }
  }

  // take a string like "1z" and turn it into the number it really is
  unBase(str: string): number {
    if (this.alphabet === "") {
      return parseInt(str, this.radix);
    }

    let ret = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charAt(str.length - 1 - i);
      const value = this.dictionary[char];
      if (value !== undefined) {
        ret += Math.pow(this.radix, i) * value;
      }
    }
    return ret;
  }
}

// sniff out and peel apart p.a.c.k.e.r-packed JS when you just want to see the real code
export class JSPacker {
  readonly packedJS: string;

  constructor(packedJS: string) {
    this.packedJS = packedJS;
  }

  // true if this code is wrapped in the classic eval(function(p,a,c,k,e,...)
  detect(): boolean {
    return /eval\(function\(p,a,c,k,e,(?:r|d)/.test(
      this.packedJS.replace(/ /g, ""),
    );
  }

  // actually perform the unpacking trick, or bail out with null
  unpack(): string | null {
    try {
      const exp =
        /\}\s*\('(.*)',\s*(.*?),\s*(\d+),\s*'(.*?)'\.split\('\|'\)/s;
      const matches = exp.exec(this.packedJS);
      if (!matches || matches.length !== 5) return null;

      let payload = matches[1]!.replace(/\\'/g, "'");
      const radix = parseInt(matches[2]!, 10) || 36;
      const count = parseInt(matches[3]!, 10) || 0;
      const symArray = matches[4]!.split("|");

      if (symArray.length !== count) {
        throw new Error("Unknown p.a.c.k.e.r. encoding");
      }

      const unBase = new UnBase(radix);

      payload = payload.replace(/\b\w+\b/g, (word: string): string => {
        const index = unBase.unBase(word);
        if (index < symArray.length && symArray[index]) {
          return symArray[index];
        }
        return word;
      });

      return payload;
    } catch {
      return null;
    }
  }
}

// convenience wrapper used by callers; complains loudly if no packing detected
export function unpackJsAndCombine(packedCode: string): string {
  const packer = new JSPacker(packedCode);
  if (packer.detect()) {
    const result = packer.unpack();
    if (result) return result;
  }
  throw new Error("Unable to unpack JS — not a valid p.a.c.k.e.r payload");
}
