// Server action ze staré záložky po nasazení nové verze selže (id akce se
// s každým buildem mění), stejně jako při výpadku sítě — volání pak vyhodí
// výjimku a bez ošetření zůstane viset skeleton nebo zamčené tlačítko.
const STALE_MESSAGE =
  "Akce se nepovedla — obnov prosím stránku (mohla vyjít nová verze).";

/** Zavolá server action; výjimku vrátí jako běžné `{ error }`. Výsledky akcí
    tu mají kromě `error` jen volitelná pole, takže tvar sedí. */
export async function safeAction<T extends { error?: string }>(
  call: () => Promise<T>
): Promise<T> {
  try {
    return await call();
  } catch (err) {
    console.error("server action failed", err);
    return { error: STALE_MESSAGE } as T;
  }
}
