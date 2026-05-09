// Kwik HLS Cipher – takes the ridiculous encoded blob the player hands us and
// turns it back into the little HTML form with the action URL and token.
// ripped from the Dart code in mangayomi/aniyomi but in TypeScript now.
//
// packedStr: the string we got from the site
// key: custom alphabet for number conversion
// offsetStr: a number-as-string we subtract from char codes
// delimiterIndex: which character splits values (also the radix)
// returns the raw HTML so the scraper can grab the URL/token
export function decrypt(
  packedStr: string,
  key: string,
  offsetStr: string,
  delimiterIndex: number,
): string {
  const offset = parseInt(offsetStr, 10);
  if (isNaN(offset)) {
    throw new Error("Invalid offset value for decryption");
  }

  const delimiter = key[delimiterIndex];
  const radix = delimiterIndex;
  let html = "";
  let i = 0;

  while (i < packedStr.length) {
    // Read characters until delimiter
    let chunk = "";
    while (i < packedStr.length && packedStr[i] !== delimiter) {
      chunk += packedStr[i];
      i++;
    }

    // Convert chunk from custom alphabet to decimal digits
    let chunkWithDigits = chunk;
    for (let j = 0; j < key.length; j++) {
      chunkWithDigits = chunkWithDigits.replaceAll(key[j]!, j.toString());
    }

    // Parse as number in the given radix, subtract offset, convert to char
    const numericValue = parseInt(chunkWithDigits, radix);
    html += String.fromCharCode(numericValue - offset);

    // Skip past delimiter
    i++;
  }

  return html;
}
