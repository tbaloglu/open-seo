# Fork bakım notları

Bu klasör yalnızca bu fork'a (tbaloglu/open-seo) özgü kararları tutar. Tasarımlar numaralı dosyalardadır (`01-...md`).

## Fork'un geçiş (migration) dosyaları

Fork'un kendi şema değişiklikleri ayrı şema dosyalarında durur (`src/db/fork.schema.ts`, `src/db/pg/fork.schema.ts`), geçişleri de adında `fork` geçen dosyalardadır:

| Veritabanı | Dosya                                       |
| ---------- | ------------------------------------------- |
| SQLite/D1  | `drizzle/sqlite/0073_fork_serp_history.sql` |
| Postgres   | `drizzle/pg/0051_fork_serp_history.sql`     |

### Kural: uygulanmış geçiş dosyası silinmez, yeniden adlandırılmaz, yeniden üretilmez

Canlıdaki veritabanı hangi geçişlerin uygulandığını dosya adıyla tutar (`celld d1 migrations apply` ve `wrangler d1 migrations apply`, `d1_migrations` tablosu). Uygulanmış bir dosyanın adı değişirse ya da aynı değişiklik başka bir numarayla yeniden üretilirse, yeni dosya "yeni geçiş" sayılır, aynı tabloyu yeniden kurmaya çalışır ve "table already exists" hatasıyla açılış (`deploy/standalone/init.sh`) durur. Bu yüzden bir fork geçişi bir kez canlıya çıktıktan sonra:

- dosya adı, numarası ve içeriği aynen kalır;
- düzeltme gerekiyorsa yeni bir geçiş dosyası eklenir.

### Upstream aynı numarayla bir geçiş getirirse

Upstream kendi `0073_<ad>.sql` dosyasını eklediğinde bizimkiyle numara çakışır ama dosya adları farklıdır. Yapılacak:

1. **İki dosya da kendi adıyla kalır.** Bizimkini silip `main` üzerinde yeniden üretmek yasak (yukarıdaki kural). Dosyalar ada göre sıralanıp uygulanır; fork geçişleri yalnızca yeni tablo ve sütun eklediği için upstream'inkinden önce ya da sonra çalışması sorun değildir. Upstream'in geçişi bizim tablolarımıza ya da `projects.default_device` sütununa dokunuyorsa birleştirmeden önce sahibine sorulur.
2. **`meta/_journal.json` elle birleştirilir:** iki kayıt da kalır, `tag` değerleri dosya adlarıyla aynı kalır, `idx` değerleri sırayla yeniden verilir. Postgres tarafında (`drizzle-kit migrate`) uygulanacak geçiş `when` zaman damgasına göre seçilir: upstream kaydının `when` değeri bizimkinden küçükse, canlıda bizimki uygulanmışken upstream'inki atlanır. Bu durumda upstream kaydının `when` değeri bizimkinden büyük bir değere çekilir.
3. **`meta/NNNN_snapshot.json`:** aynı numaralı iki anlık görüntü çakışırsa en son anlık görüntünün iki şemayı da içermesi yeterlidir. Kontrol: `pnpm db:generate` yeni bir geçiş üretmemeli ("No schema changes"). Üretirse o dosya silinir ve en son anlık görüntü düzeltilir; geçiş dosyalarına dokunulmaz.
4. Boş bir veritabanında bütün geçişler baştan uygulanarak denenir (`pnpm db:migrate:local`, testlerdeki `src/server/features/ai-visibility/aiVisibilityTestDb.ts`).
