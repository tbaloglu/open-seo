# Fork tasarımı 01: Sonuç sayfası geçmişi, yapılacaklar listesi, keyword gap

Durum: onaylandı (20.11.2026); kararlar en altta. Bu fork'a (tbaloglu/open-seo) özgüdür; upstream'e önerilmeyecek.

## Amaç

Sahibi her ay şu soruların cevabını OpenSEO'da görmek istiyor:

1. Bizim ve rakiplerin Google'daki yeri geçen aya göre nasıl değişti?
2. Google'ın sayfasında yeni ne çıktı? Örneğin yeni "Diğer sorular" soruları, AI özetinde kaynak olan siteler, video ya da harita kutusu.
3. Bu veriden çıkan yapılacak işler neler, hangileri seçildi, hangileri yapıldı ve yapılanların etkisi ne oldu?

Bugün bunların hiçbiri kalıcı değil. `get_serp_results` sonucu 12 saat sonra siliniyor; sıralama takibi ise yalnızca bizim sıramızı saklıyor.

## Bugünkü durum (kodda)

- Sıralama takibi (`RankCheckWorkflow`, `rankCheckPaths.ts`) DataForSEO standart kuyruğunu kullanır, gerçek adresleri alır ve varsayılan olarak ilk 40 sonucu okur.
- `buildRankCheckResult` (`src/server/lib/dataforseo/serp.ts`) sonuç sayfasının bütün öğelerini elinde tutar. Ancak yalnızca şunları döndürür:
  - bizim alan adımızın sırası,
  - adresimiz,
  - sayfadaki öğe türlerinin listesi.

  Geri kalan her şey atılır.

- `rank_snapshots` her çalıştırmada, her kelime ve her cihaz için tek satır tutar: `position`, `url`, `serp_features` (türler, JSON).
- Zamanlama zaten var: elle, günlük, haftalık, aylık.
- Rakip izlemek için rakip alan adıyla ayrı bir takip açılabiliyor. Ancak her rakip aynı aramaları yeniden satın alır ve bu yöntem yeni rakip keşfetmez.

## Öneri

### A. Sonuç sayfası geçmişi (veritabanı değişir)

Sıralama kontrolü, zaten satın aldığı sayfadan şunları da saklar:

- **İlk 10 normal sonuç:** sıra, alan adı, adres, başlık.
- **Sayfa öğeleri ve içerikleri:**
  - "Diğer sorular" soruları,
  - AI özeti kaynakları (alan adı ve başlık),
  - ilgili aramalar ve "diğer kullanıcılar şunları da aradı",
  - harita kutusundaki işletmeler,
  - "Yer siteleri" kutusundaki siteler,
  - video ve kısa video kutusunun varlığı.

Yeni iki tablo eklenir. Mevcut `rank_snapshots` tablosuna dokunulmaz. Veri JSON olarak değil, satır satır tutulur; bu, AGENTS.md'deki normalleştirme kuralının gereği.

- `serp_snapshot_results`: `run_id`, `tracking_keyword_id`, `device`, `rank`, `domain`, `url`, `title`
- `serp_snapshot_features`: `run_id`, `tracking_keyword_id`, `device`, `feature_type`, `sort_order`, `value`, `domain`

Yeni tablolar ayrı bir şema dosyasında durur (`fork.schema.ts` ve Postgres karşılığı). Böylece upstream güncellemeleri alınırken çakışma çıkmaz. SQLite ve Postgres ile uyumlu olmalıdır.

Boyut: Site başına 100 kelime ve haftalık kontrolle yılda yaklaşık 52.000 sonuç satırı ile 30.000 öğe satırı birikir. Bu, SQLite için küçük bir yük.

**Ekranlar** (sıralama takibi sayfasına yeni sekmeler):

1. **Rakipler:** Her alan adının kaç kelimede ilk 10'da olduğu ve bunun çalıştırmalar boyunca nasıl değiştiği. Yeni giren ve düşen alan adları işaretlenir.
2. **Neler değişti:** Son çalıştırmayı bir öncekiyle karşılaştırır:
   - sıramızın değiştiği kelimeler,
   - ilk 10'a giren ya da çıkan siteler,
   - yeni çıkan sorular,
   - AI özetine girdiğimiz ya da çıktığımız kelimeler.
3. **Sorular ve kaynaklar:** Bütün kelimelerdeki "Diğer sorular" soruları ve AI özeti kaynakları tek listede, kaç kelimede görüldükleriyle birlikte.

**MCP araçları:** `get_serp_history` (bir kelimenin geçmişi) ve `get_serp_changes` (iki çalıştırma arasındaki fark). Claude aylık raporu bu araçlarla yazar.

### B. Proje varsayılan cihazı (veritabanı değişir, küçük)

`projects` tablosuna `default_device` alanı eklenir (`mobile` ya da `desktop`, varsayılan `mobile`). Bu alanı şunlar kullanır:

- SERP Analysis kartı,
- `get_serp_results`,
- yeni oluşturulan sıralama takibi.

Ekran ve MCP aracı bu ayarı geçersiz kılabilir.

### C. Yapılacaklar listesi (veritabanı değişir)

Bugün yapılacaklar salt okunur bir rapor sayfasında duruyor. Önerilen yapı, proje başına işaretlenebilir bir liste:

- Tablo: `seo_tasks`. Alanları:
  - `project_id`, `code` (ör. A1), `title`, `description`
  - `evidence` (dayanak metni), `affected_urls`, `expected_impact`
  - `size` (S/M/L), `priority` (yüksek/orta/düşük)
  - `status` (öneri / seçildi / yapılıyor / yapıldı / vazgeçildi)
  - `source_report_id`
  - `created_at`, `status_changed_at`, `done_at`
  - `outcome_note` (yapıldıktan sonra ölçülen etki)
- Ekran: Projede "Yapılacaklar" sayfası. Durum, öncelik ve büyüklüğe göre süzülür. Durum bir tıkla değişir.
- MCP araçları:
  - `list_seo_tasks`
  - `save_seo_tasks` (toplu ekleme ve güncelleme)
  - `update_seo_task_status`

  Claude rapor yazarken işleri bu araçlarla listeye ekler. Sahibi bir işi "seçildi" yapınca Claude onu site deposunun `docs/tasks.md` dosyasına aktarır. İş bittiğinde durumu ve etkisini günceller.

- Aylık rapor, bir önceki aydan beri yapılan işleri ve GSC'deki etkilerini (öncesi ve sonrası) ayrı bir bölümde gösterir.

### D. Keyword gap aracı (veritabanı değişmez)

Yeni MCP aracı: `get_keyword_gap(projectId, competitorDomain)`.

- DataForSEO Labs'ten rakibin sıralandığı kelimeleri çeker (`get_ranked_keywords` ile aynı kaynak).
- Projenin GSC aramalarını çeker (son 3 ay).
- Bizim hiç görünmediğimiz ya da 20. sıranın gerisinde kaldığımız kelimeleri, hacim ve rakibin sırasıyla birlikte döndürür.
- Türkçe büyük-küçük harf eşleştirmesi doğru yapılır.

Bugün bu işi elle yaptık: dogaltursu.com için 76 kelimenin 72'si boşluk çıktı. Ekran ikinci aşamada eklenir.

### E. Aylık döngü

1. Her projede, sahibinin seçtiği kelimeler için aylık bir sıralama takibi çalışır. Kelimeler GSC'den ve yapılacaklar listesindeki hedeflerden seçilir. Takip mobil olur ve ilk 40 sonucu okur.
2. Takip bitince Claude zamanlanmış bir görevle şunları yapar:
   - "Neler değişti" verisini, GSC'yi ve keyword gap'i okur.
   - Tarihli yeni bir rapor yazar.
   - Yeni işleri listeye ekler.
   - Yapılmış işlerin etkisini ölçer.
3. Sahibi raporu okur ve işleri seçer.

## Maliyet

Sıralama takibi bir okumayı standart kuyrukta yapar. İlk 40 sonuç için bir okuma 0,00315 $ tutar (`costPerRankCheckRead`): 0,00255 $ okuma ve zehirli sayfa denetimi, 0,0006 $ da sonradan yüklenen AI Overview için (`load_async_ai_overview`, derinlik 40 ve üstünde açık; sayfada böyle bir AI Overview yoksa DataForSEO bu payı iade eder). Sonuçları saklamak ek arama satın almaz.

| Kapsam                        | Sıklık   | Aylık    |
| ----------------------------- | -------- | -------- |
| 1 site, 100 kelime, mobil     | aylık    | ≈ 0,32 $ |
| 1 site, 100 kelime, mobil     | haftalık | ≈ 1,36 $ |
| 14 site, 100'er kelime, mobil | aylık    | ≈ 4,41 $ |

OpenSEO'nun kendi tahmin aracı, tekrar okuma ihtimali yüzünden en kötü durumu iki okuma sayar. Gerçek maliyet genelde bu tahminin yarısına yakın çıkar.

## Riskler

- **Şema değişikliği:** Çekirdek kurallar (1.1, 1.2) gereği canlıya çıkmadan önce sahibine sorulur. Geçiş (migration) önce yerelde, sonra canlı verinin yedeği alınarak yapılır.
- **Upstream çakışması:** Yeni tablolar ayrı dosyada durur. Sıralama kontrolüne yalnızca birkaç satırlık bir çağrı eklenir. Upstream bu dosyaları değiştirirse çakışma o birkaç satırla sınırlı kalır.
- **Rakip görünümünün yanılgısı:** Tek bir okuma gürültülüdür; Google aynı aramada her seferinde biraz farklı sonuç gösterir. Ekranlar tek çalıştırmadaki değişimi "kesin" diye göstermez. İki çalıştırmadır süren değişimi öne çıkarır.
- **Kendi sıramız:** Asıl kaynak hâlâ GSC'dir. Ekranlar bunu açıkça söyler.

## Aşamalar

1. A, B ve sıralama kontrolüne kayıt (tek PR): tablolar, kayıt ve "Neler değişti" MCP aracı.
2. A'nın ekranları.
3. C (yapılacaklar): tablo, MCP araçları, ekran.
4. D (keyword gap aracı).
5. E: aylık döngünün kurulması (zamanlanmış görev).

## Kararlar (20.11.2026)

1. **Kelime seti site başına farklıdır ve sabit değildir.** Her takip iki parçadan oluşur:
   - **Çekirdek** (yaklaşık %70): her ay aynı kalan kelimeler, eğilim karşılaştırılabilsin diye. GSC'de gösterimi en yüksek aramalar ve yapılacaklar listesindeki işlerin hedef kelimeleri.
   - **Keşif** (yaklaşık %30): her ay yenilenir. GSC'de yeni beliren aramalar, keyword gap'ten gelen kelimeler ve "Diğer sorular"dan çıkan konular.

   Toplam sayıyı sitenin verisi belirler: son 3 ayda en az 20 gösterim alan ve ortalama sırası 30'dan iyi olan GSC aramalarının sayısı, 30 ile 200 arasında sınırlanır. Niş bir sitede (Sinastri) sayı kendiliğinden azalır; hızlı büyüyen sitede (Voleybol) artar. Sahibi site başına bu sayıyı elle de değiştirebilir.

2. **Sıklık:** Sitedeki değişiklikler aylık yapılır. Ücretli sıralama takibi aylık çalışır. Ücretsiz kaynaklar (GSC, GA4) ise günlük izlenir; bkz. F.
3. **Yapılacaklar durumları:** öneri, seçildi, yapılıyor, yapıldı, vazgeçildi.
4. **Aşama sırası:** "Aşamalar" bölümündeki gibi.

### F. Günlük ücretsiz nabız (ek)

Günlük iş iki şey yapar: G'deki arşive o günün verisini ekler ve **uyarı** üretir. Uyarı durumları:

- bir sayfanın tıklamaları ya da gösterimleri son 7 günün ortalamasına göre belirgin düştü;
- daha önce gösterim alan bir sayfa gösterim almaz oldu (Giresun il sayfasında olduğu gibi: dizinden çıkma, noindex);
- yeni bir arama hızla gösterim almaya başladı;
- GA4'te organik oturumlar sert düştü.

Uyarılar yapılacaklar listesine "öneri" olarak düşer ve aylık rapora girer. Bu iş sunucuda çalışır, Claude'u her gün çalıştırmaz; yani token maliyeti yok. Aşama sırasında E'den sonra gelir.

### G. GSC ve GA4 arşivi (veritabanı değişir)

Google, Search Console verisini 16 ay saklar; daha eskisi kaybolur. Yıllar arası karşılaştırma (ör. "geçen yılın kışlık turşu sezonu") için kendi arşivimiz gerekir. Sahibinin itirazıyla eklendi (20.11.2026).

Arşivin ayrıntı düzeyi, veri hacmiyle değeri dengeleyecek şekilde seçildi:

- **Günlük, site toplamı:** tıklama, gösterim, ortalama sıra, cihaz kırılımı (GSC); oturum, organik oturum, hedef eylem sayısı (GA4).
- **Günlük, sayfa bazında:** tıklama, gösterim, ortalama sıra (GSC); organik oturum (GA4).
- **Aylık, arama × sayfa bazında:** ayın toplam tıklaması, gösterimi ve ortalama sırası (GSC). Günlük arama × sayfa verisi tutulmaz; site başına günde binlerce satır eder ve yıllık karşılaştırmada aylık toplam yeter.

Doldurma: ilk kurulumda GSC'nin elindeki 16 ay ve GA4'ün elindeki dönem bir kez çekilir. Sonra her gün bir önceki günün verisi eklenir. GSC son 2-3 günü sonradan düzelttiği için son 4 gün her çalıştırmada yeniden yazılır. Aylık arama × sayfa toplamı ay bittikten 4 gün sonra yazılır.

Tahmini boyut: 14 site için yılda yaklaşık 1,5 milyon satır (çoğu aylık arama × sayfa). Bu, SQLite ve Postgres için sorun değil.

MCP: `get_search_console_performance` ve GA4 araçları, istenen tarih 16 aydan eskiyse arşivden okur ve cevabında bunu belirtir.

Aşama sırası güncel hâli: 1) A+B, 2) A ekranları, 3) C, 4) D, 5) E, 6) F+G (günlük nabız ve arşiv). Arşiv ne kadar erken başlarsa o kadar çok veri kurtarılır; bu yüzden G'nin doldurma kısmı mümkünse 3. aşamayla birlikte öne alınır.
