# Fork bakım notları

Bu klasör yalnızca bu fork'a (tbaloglu/open-seo) özgü kararları tutar. Tasarımlar numaralı dosyalardadır (`01-...md`).

## Fork'un geçiş (migration) dosyaları

Fork'un kendi şema değişiklikleri ayrı şema dosyalarında durur (`src/db/fork.schema.ts`, `src/db/pg/fork.schema.ts`), geçişleri de adında `fork` geçen dosyalardadır:

| Veritabanı | Dosya                                                   |
| ---------- | ------------------------------------------------------- |
| SQLite/D1  | `drizzle/sqlite/0073_fork_serp_history.sql`             |
| Postgres   | `drizzle/pg/0051_fork_serp_history.sql`                 |
| SQLite/D1  | `drizzle/sqlite/0074_fork_seo_tasks_search_archive.sql` |
| Postgres   | `drizzle/pg/0052_fork_seo_tasks_search_archive.sql`     |
| SQLite/D1  | `drizzle/sqlite/0075_fork_project_topic_words.sql`      |
| Postgres   | `drizzle/pg/0053_fork_project_topic_words.sql`          |

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

## Upstream eşitleme rutini

Ayda bir yapılır.

1. `git fetch upstream` ve `git fetch origin`; `origin/main`'den `bakim/upstream-senkron-<tarih>` dalı açılır.
2. `git merge upstream/main` (rebase değil; upstream commit'leri yazarlarıyla kalır).
3. Çakışmalarda upstream kodu esas alınır, fork özellikleri çalışır kalır. Geçiş dosyalarında yukarıdaki kurallar geçerlidir: iki dosya da kalır, `_journal.json` elle birleştirilir, en son anlık görüntü iki şemayı da içerir. Eklenti sürümü (üç `plugin.json`) ikisinden büyük olanı alır. Eşitlemeden sonra üretilen bir sonraki geçişin numarası bir atlayabilir (journal `idx` ile anlık görüntü numarası ayrışır); bu beklenen bir durumdur, düzeltilmez.
4. Denetim: `pnpm ci:check`, `pnpm test:ci`, `pnpm build`, `pnpm db:generate` ("No schema changes"), boş veritabanında bütün geçişler baştan; canlı benzeri bir veritabanında yalnızca yeni geçişlerin uygulandığı da denenir.
5. Kırmızı takım: upstream'in getirdiği yeni açık adresler, giriş ve ortam değişkeni değişiklikleri, kurulum ekranındaki yeni yönlendirmeler Docker/Coolify kurulumumuz (`AUTH_MODE=password`) için tek tek okunur.
6. Aşağıdaki "Upstream'den ayrılan noktalar" listesi yeniden kontrol edilir: kapatılan özellik hâlâ kapalı mı, kapatma nedeni sürüyor mu.
7. PR açılır (ne geldi, çakışmalar, ne doğrulandı, risk).
8. Yayından önce canlı veritabanının yedeği alınır; yayından sonra açılış günlüğünde geçişlerin uygulandığı ve sitenin açıldığı kontrol edilir.

### Upstream'den ayrılan noktalar

- **Move to Every App kapalı** (`src/shared/fork-flags.ts`, `MOVE_TO_EVERY_APP_ENABLED = false`): ayarlardaki bölüm gösterilmez, taşıma sunucu fonksiyonları `FORBIDDEN` döner. Neden: şemamız upstream'inkinden farklı, taşıma hedefe yarım yazar.
