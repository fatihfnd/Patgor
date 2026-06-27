# Proje Brief — Patoloji Mikroskop Görüntü Düzeltme Web Uygulaması

> Bu dosya, Claude Code'a verilecek başlangıç talimatıdır. İçeriği Code oturumuna ilk
> mesaj olarak yapıştırabilir ya da dosyayı oturuma ekleyip (@mention) gösterebilirsin.

## Amaç
Patoloji laboratuvarında farklı kameralarla çekilen mikroskobik görüntüler çoğu zaman
kötü ışık, bozuk beyaz dengesi, düşük kontrast ve renk kaymasıyla çıkar. Lam tarayıcıların
(slide scanner) çıktıları ise temiz ve standarttır. Bu uygulama, kötü çekilmiş kamera
görüntülerini **otomatik olarak tarayıcı çıktısına yakın** hale getirir. En kötü girdilerde
bile çökmeden, mümkün olan en iyi sonucu üretmelidir.

Bu, dijital patolojide **"stain normalization" (boya normalizasyonu)** olarak bilinen,
üzerine çok çalışılmış bir alandır; kanıtlanmış yöntemler kullanılacak.

## Teknik yapı (önemli)
- **Tamamen tarayıcıda (client-side) çalışan statik web uygulaması. Sunucu YOK.**
  Görüntüler kullanıcının bilgisayarından çıkmamalı (hasta gizliliği / KVKK).
- HTML + JavaScript + **OpenCV.js** (WASM). Ağır görüntü işleme OpenCV.js ile yapılacak.
- Netlify gibi statik hosting'e konabilmeli.
- Yerelde test: `python -m http.server 8000`. (OpenCV.js WASM `file://` ile çalışmaz,
  http üzerinden sunulmalı.)
- Yeni ve bağımsız bir proje olacak (ileride PatoLIS'e modül olarak eklenebilir, şimdilik ayrı).

## Geliştirme tarzı (lütfen bunlara uy)
- **Önce iskelet, sonra detay:** önce tüm arayüz ve uçtan uca akış kaba haliyle çalışsın
  (görüntü yükle → basit otomatik düzeltme → önce/sonra göster → dışa aktar), **sonra**
  her algoritmayı tek tek iyileştir.
- Tarayıcı testini kullanıcı kendisi ekran görüntüsüyle yapacak.
  **Playwright veya herhangi bir tarayıcı otomasyonu KULLANMA.**
- Ortam: Windows (PowerShell + Git Bash).

## Özellikler

### 1. Görüntü girişi
- Sürükle-bırak ve dosya seçici.
- Tekli ve **toplu (batch)** işleme — birçok görüntü aynı anda.
- Format: JPG, PNG, TIFF. (TIFF için tarayıcının yerleşik desteği yok; UTIF.js gibi bir
  JS kütüphanesiyle çöz/encode et.)

### 2. Otomatik düzeltme hattı (pipeline) — bu sırayla
1. **Işık eğimi / vinyetleme düzeltme (flat-field correction):** halojen lambalı
   mikroskoplarda "ortası parlak, kenarları koyu" gradyanı düzleştir. Arka plan
   aydınlatmasını büyük çekirdekli bulanıklaştırma / morfolojik açma / polinom yüzey
   uydurma ile tahmin edip böl.
2. **Beyaz dengesi + zemini beyaza çekme:** boş lam camı (en parlak, en az doygun
   bölgeler) tespit edilip gerçek beyaza eşlenmeli.
3. **Boya tipini algıla:** renk dekonvolüsyonu (Ruifrok–Johnston) ile boyaları ayır.
   - **H&E:** hematoksilen (mor/mavi) + eozin (pembe) imzası
   - **İHK:** güçlü kahverengi (DAB) kanalı varsa
   - **Histokimya** boyaları da desteklensin
   - Otomatik tahmin yapılsın ama kullanıcı elle değiştirebilsin (H&E / İHK / Histokimya).
4. **Boya normalizasyonu:** Macenko veya Reinhard yöntemiyle, referans görüntüye eşitle.
   - H&E için yapı koruyan (structure-preserving) normalizasyon.
   - İHK için: karşıt boya (hematoksilen zemin) ile pozitif sinyal (DAB kahverengi)
     **ayrı ayrı** ayarlanabilsin.
5. **Kontrast (CLAHE) + keskinlik (unsharp mask).**

### 3. Referans görüntü
- Kullanıcı "iyi" bir tarayıcı görüntüsü yükleyip renk hedefini ondan tanımlayabilsin.
- Kullanıcı referans vermezse diye 2–3 makul yerleşik varsayılan hedef de olsun.

### 4. Manuel mod (otomatiğin yanında)
Kaydırıcılarla elle ince ayar:
- Renk sıcaklığı / beyaz dengesi
- Parlaklık, kontrast, doygunluk
- Boya yoğunlukları (hematoksilen / eozin / DAB ayrı)
- Keskinlik
- Işık eğimi düzeltme şiddeti

### 5. Önce/sonra önizleme
- Yan yana veya ortadan kaydırmalı (before/after slider) karşılaştırma.

### 6. Dışa aktarma
- **DPI** ayarı (dosya metadata'sına yazılsın)
- Çıktı **piksel boyutu** (yeniden boyutlandırma)
- **Dosya türü:** JPG (kalite ayarı), PNG, TIFF
- Tekli indir + toplu indir (zip).

## İlk sürüm kabul kriteri
- Kötü ışıklı bir H&E ve bir İHK kamera görüntüsü yüklendiğinde otomatik mod, gözle
  görülür biçimde daha temiz, dengeli renkli ve düz aydınlatmalı çıktı üretmeli.
- En kötü / aşırı bozuk görüntüde uygulama çökmemeli; elinden gelen düzeltmeyi yapmalı.

## İlk adım
İskeleti kur: görüntü yükleme alanı, önce/sonra tuvali, sol/sağda kontrol paneli, otomatik
düzeltme düğmesi ve dışa aktarma paneli — hepsi kaba çalışan halde. Otomatik hattın ilk
basit sürümünü (flat-field + beyaz dengesi + temel kontrast) bağla. Sonra adım adım
geliştiririz.
