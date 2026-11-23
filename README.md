# Pagedf — Web Sayfasını PDF'e Kaydet

Açık olan web sayfasını, ekrandaki görünümünü bozmadan; tüm görselleri, tabloları,
renkleri ve düzeniyle birlikte tek tıkla PDF olarak kaydeden bir Chrome eklentisi.

Sayfa, Chrome'un kendi PDF motoru (DevTools Protocol → `Page.printToPDF`) ile
işlendiği için metinler seçilebilir, bağlantılar tıklanabilir ve dosya boyutu
ekran görüntüsü tabanlı yöntemlere göre çok daha küçük olur.

## Özellikler

- **Ekran görünümünü korur** — varsayılan olarak sayfanın ekrandaki (screen) CSS
  görünümünü kullanır, sitedeki `@media print` stillerinin sayfayı bozmasını engeller.
- **Arka planlar ve renkler** — renkli kutular, temalar ve arka plan görselleri korunur.
- **Tembel yüklenen görseller** — PDF alınmadan önce sayfa otomatik kaydırılarak
  `loading="lazy"` görseller ve aşağı kaydırınca beliren bölümler yüklenir.
- **Sayfa ayarları** — A4 / Letter / Legal / A3 / A5 / Tabloid veya sayfanın kendi
  boyutu; dikey/yatay; kenar boşluğu; ölçek (%50–%150).
- **Üst/alt bilgi (isteğe bağlı)** — başlık, tarih, adres ve sayfa numarası.
- **Dosya adı** — sayfa başlığından otomatik üretilir ve güvenli hale getirilir.
- **Ayarlar hatırlanır** — son kullandığınız seçenekler saklanır.
- **Karanlık tema desteği** — sistem temasına uyum sağlar.

## Kurulum (Chrome / Edge / Brave)

1. Tarayıcıda `chrome://extensions` adresini açın.
   (Edge: `edge://extensions`, Brave: `brave://extensions`)
2. Sağ üstten **Geliştirici modu**'nu açın.
3. **Paketlenmemiş öğe yükle** düğmesine tıklayıp bu klasörü (`pagedf`) seçin.
4. Eklenti çubuğunda **Pagedf** simgesi görünür. Sabitlemek için puzzle simgesinden
   raptiyeleyin.

## Kullanım

1. PDF'e kaydetmek istediğiniz sayfayı açın ve sayfanın tamamen yüklenmesini bekleyin.
2. Araç çubuğundaki **Pagedf** simgesine tıklayın.
3. İsterseniz kağıt boyutu, yön, kenar boşluğu ve ölçeği ayarlayın.
4. **PDF olarak kaydet** düğmesine basın. Kaydetme konumu sorulur; dosya seçtiğiniz
   yere (veya İndirilenler klasörüne) `.pdf` olarak indirilir.

İşlem sürerken kısa süreliğine Chrome'un "Bu tarayıcıda hata ayıklanıyor" bilgi
çubuğu görünür; PDF üretildikten sonra otomatik kalkar.

## Ayarlar

| Ayar | Açıklama |
| --- | --- |
| Kağıt boyutu | PDF sayfa boyutu. "Sayfanın kendi boyutu" seçilirse sitenin `@page` kuralı kullanılır. |
| Yön | Dikey veya yatay. |
| Kenar boşluğu | Yok / Dar / Normal / Geniş. |
| Ölçek | İçeriğin sayfaya oranı. Taşan tablolar için %75–%90 deneyin. |
| Arka planlar ve renkler | Kapalıysa yalnızca beyaz zemin üzerine metin/çizgiler basılır. |
| Ekran görünümünü koru | Kapalıysa sayfanın yazdırma (`print`) stilleri kullanılır. |
| Görselleri önceden yükle | Uzun sayfalarda geç yüklenen görseller için sayfayı otomatik kaydırır. |
| Üst/alt bilgi | Her sayfaya başlık, tarih, adres ve sayfa numarası ekler. |
| Kaydetme konumunu sor | Kapalıysa doğrudan İndirilenler klasörüne kaydedilir. |

## Sınırlamalar

- `chrome://`, `edge://`, `brave://`, `about:` gibi tarayıcı iç sayfaları ve
  Chrome Web Mağazası sayfaları güvenlik nedeniyle kaydedilemez.
- Sekmede Geliştirici Araçları (DevTools) açıkken PDF üretilemez; DevTools'u kapatın.
- PDF her zaman sayfa (kağıt) genişliğine göre yeniden akıtılır. Duyarlı (responsive)
  sitelerde ekran genişliğinden farklı bir sütun düzeni görülebilir — bu, Chrome'un
  yazdırma motorunun doğasıdır (Ctrl+P ile aynı davranış).
- `file://` adresleri için `chrome://extensions` sayfasında eklentinin
  **"Dosya URL'lerine erişime izin ver"** anahtarının açık olması gerekir.
- Aşırı büyük sayfalarda (yüzlerce MB) PDF üretimi birkaç dakika sürebilir; 2 dakikalık
  zaman aşımı vardır.
- Bazı siteler çok büyük veya sonsuz kaydırmalıdır; "Görselleri önceden yükle" seçeneği
  ilk 60 ekranı tarar.

## Gizlilik

Sayfa içeriği veya ayarlar hiçbir sunucuya gönderilmez. Tüm işlem tarayıcınızın
içinde gerçekleşir; ayarlar yalnızca `chrome.storage.local` içinde tutulur.

## Dosya yapısı

```
pagedf/
├── manifest.json     # Manifest V3 tanımı
├── background.js     # Servis çalışanı: debugger + printToPDF + indirme
├── popup.html        # Arayüz
├── popup.css         # Arayüz stilleri (açık/karanlık tema)
├── popup.js          # Arayüz mantığı ve ayar saklama
├── icons/            # 16/32/48/128 px simgeler
└── README.md
```

## Teknik not

PDF üretimi şu adımlarla yapılır:

1. `chrome.debugger` ile sekmeye CDP oturumu bağlanır (`1.3`).
2. `Runtime.evaluate` ile sayfa kaydırılarak tembel görseller tetiklenir.
3. `Emulation.setEmulatedMedia({ media: 'screen' })` ile ekran CSS'i zorlanır.
4. `Page.printToPDF` çağrılır (`printBackground: true`, istenen kağıt/marj/ölçek).
5. Emülasyon sıfırlanır, debugger ayrılır.
6. PDF, `chrome.downloads.download` ile base64 data URL üzerinden indirilir.
