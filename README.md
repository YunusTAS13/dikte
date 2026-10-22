# Dikte 🎙️

Konuşmayı Türkçe canlı altyazıya dönüştüren yerel web uygulaması. Varsayılan kullanımda ses aynı bilgisayardaki sunucuda işlenir; ilk kurulumda konuşma modeli Hugging Face üzerinden indirilir.

Varsayılan olarak NVIDIA GPU varsa large-v3-turbo, GPU yoksa CPU'ya uygun küçük çok dilli Whisper modeli seçilir.

## Neler yapıyor

- **Canlı yazı**: sen konuşurken ~0,4 sn'de bir tahmin ekranda güncellenir (gri italik).
- **Kararlı metin**: cümle bitip kısa bir sessizlik olunca metin kesinleşir ve bir daha değişmez.
- **Türkçe odaklı**: dil sabit `tr`, noktalama ve büyük harf modelden gelir; önceki cümle bağlam olarak verilir.
- **Otomatik yazma**: istersen kesinleşen metin, imlecinin olduğu uygulamaya yazılır (KDE Wayland'da `ydotool` ile).
- **Global kısayol**: `F9` ile nerede olursan ol kaydı başlat/durdur.
- Kopyala, `.txt` indir, temizle, kelime/karakter sayacı, gecikme göstergesi.

## Demo videosu

Depodaki [dikte-demo.mp4](media/dikte-demo.mp4) videosu klonlama ile birlikte indirilir.

## Gereksinimler

- Linux (X11 veya Wayland), mikrofon ve güncel tarayıcı
- Güncel x86_64 Linux; NVIDIA GPU varsa daha büyük model ve daha iyi hız sağlar
- Kurulum için `curl`; `install.sh` uv ve Python 3.12'yi otomatik kurar
- Otomatik yazma için: `ydotool` + `/dev/uinput` erişimi, ya da `xdotool`

## Kurulum ve yerel kullanım

```bash
git clone https://github.com/YunusTAS13/dikte.git
cd dikte
./install.sh     # Python 3.12 venv + faster-whisper (CUDA zorunlu değil)
./run.sh         # sunucuyu başlatır ve tarayıcıyı açar
```

İlk çalıştırmada model indirilir; GPU'lu makinede büyük model yaklaşık 1.6 GB, CPU kipinde kullanılan tiny model yaklaşık 75 MB'dır. Sonraki açılışlarda yerel önbellekten yüklenir.

### FATİH Faz 1 notu

Faz 1 Vestel kılavuzundaki örnek donanım i3-2310M, en çok 4 GB RAM ve Intel HD 3000 grafik birimidir. Bu nedenle kurulum CUDA paketlerini yüklemez; NVIDIA GPU bulunmuyorsa CPU'da int8 ve tiny model seçer. Eski tarayıcıda AudioWorklet yoksa ScriptProcessor tabanlı ses işleme yedeği kullanılır. Bu uyumluluk ayarları tahtada açılmayı hedefler; eski CPU'da canlı altyazı gecikebilir ve tiny modelin Türkçe doğruluğu büyük modele göre daha düşüktür. Ders kullanımından önce tahtada mikrofon, gecikme ve kelime doğruluğu mutlaka denenmelidir.

## Kullanım

1. `./run.sh` → `http://127.0.0.1:8765`
2. **Başlat** (veya `Boşluk` / `F9`) de ve konuş.
3. Gri yazı = canlı tahmin, beyaz yazı = kesinleşmiş metin.
4. **Otomatik yazma**yı açtıysan, imleci hedef uygulamaya koy; cümle bitince metin oraya yazılır.

## Ağda başka cihazdan kullanım

Akıllı tahta tarayıcısının sunucuya erişebilmesi için uygulamayı GPU/modelin bulunduğu Linux bilgisayarda çalıştırın. Aynı yerel ağdan erişimi açmak için:

```bash
DIKTE_HOST=0.0.0.0 ./run.sh
```

Sunucunun LAN IP adresini `hostname -I` komutuyla bulun; tahtada `http://SUNUCU_IP:8765` adresini açın. Mikrofon erişimi uzak HTTP sayfalarında çoğu tarayıcıda engellenir. Gerçek kullanımda HTTPS reverse proxy (ör. Caddy/Nginx) ve sertifika gerekir. Portu doğrudan internete açmayın; erişim kontrolü ve okul ağı kurallarını ayrıca yapılandırın. `./run.sh`, LAN modunda sunucu bilgisayarında tarayıcı açmaz.

## GitHub Pages

`docs/` klasörü GitHub Pages arayüzünü içerir. `static/` kaynaklarını değiştirdikten sonra `./build-pages.sh` çalıştırıp commit/push edin. GitHub deposunda Settings → Pages → Build and deployment → Source bölümünde **Deploy from a branch**, `main` ve `/docs` seçin. Yayın adresi: `https://yunustas13.github.io/dikte/`. Pages yalnızca statik arayüzdür; Whisper modeli burada çalışmaz. Sayfayı açınca **Transkripsiyon sunucusu** alanına, HTTPS ve WSS sunan Dikte sunucunuzun adresini yazıp **Bağlan**'a basın. Adres bu tarayıcıda saklanır.

Sunucu tarafında HTTPS reverse proxy ile `/` ve `/ws` uçlarını uygulamanın `127.0.0.1:8765` adresine yönlendirin. Tarayıcı güvenlik kısıtları nedeniyle GitHub Pages'tan `http://` veya şifrelenmemiş `ws://` sunucusuna mikrofon akışı gönderilemez. Sayfa dağıtımı için repo Settings → Pages → Build and deployment → Source değerinin **GitHub Actions** olması gerekir.

> Not: Otomatik yazma açıkken bu sayfa odaktaysa metin sayfaya değil panoya gider. Hedef uygulamayı odakta tut.

## Nasıl çalışıyor

```
Mikrofon ──► AudioWorklet (16 kHz mono float32) ──WebSocket──► FastAPI
                                                                 │
                                       enerji tabanlı ses/sessizlik takibi
                                                                 │
                                          faster-whisper large-v3-turbo (CUDA)
                                                                 │
                            partial (~0,4 sn)  ──►  tarayıcıda canlı metin
                            commit (sessizlik) ──►  kalıcı metin + otomatik yazma
```

- Sessizlik eşiği gürültü tabanına göre uyarlanır; sabit bir eşik yok.
- Her commit'te son 200 karakter `initial_prompt` olarak verilir; böylece noktalama/bağlam tutarlı kalır.
- Halüsinasyon filtresi: boş/anlamsız, tekrar eden veya "altyazı M.K." tipi çıktılar atılır.
- GPU'da float16, GPU yoksa CPU'da int8'e otomatik düşer.

## Ayarlar

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `DIKTE_PORT` | `8765` | HTTP portu |
| `DIKTE_HOST` | `127.0.0.1` | Dinlenecek adres; LAN için `0.0.0.0` |
| `DIKTE_MODEL` | GPU'da large-v3-turbo, GPU'suz `Systran/faster-whisper-tiny` | faster-whisper CT2 modeli; `small`/`medium` gibi model adlarıyla değiştirilebilir |
| `DIKTE_DEVICE` | otomatik | `cpu` veya `cuda` ile aygıtı sabitle |
| `DIKTE_PARTIAL_EVERY` | GPU'da `0.10`, CPU'da `0.60` | Geçici altyazı güncelleme aralığı (saniye) |

İnce ayar için `server.py` başındaki sabitler: `SILENCE_END`, `MAX_BUFFER`, `PARTIAL_EVERY`.

## Sorun giderme

- **"Model yüklenemedi" / libcublas hatası**: `install.sh` CUDA kütüphanelerini venv içine kurar; `server.py` bunları otomatik önyükler. Yine olmazsa `nvidia-smi` ile sürücüyü kontrol et.
- **Otomatik yazma çalışmıyor**: `ydotool` kurulu mu, `/dev/uinput` yazılabilir mi (`ls -l /dev/uinput`), kullanıcı `input` grubunda mı? Değilse `xdotool` (X11 uygulamaları) denenir.
- **Mikrofon izni**: tarayıcı adres çubuğundaki mikrofon simgesinden izin ver; `localhost` güvenli bağlam sayılır.
- **Tahtadan mikrofon erişimi**: sunucuya IP ile HTTP üzerinden bağlanınca tarayıcı mikrofonu vermeyebilir; HTTPS gerekir.
- **Gecikme yüksek**: Faz 1 gibi eski CPU'larda tiny model kullanılır; daha hızlı bilgisayar/GPU kullanmak gerekebilir (`/api/status` → `device`).

## Dosyalar

```

## Lisans

Bu depoya henüz açık kaynak lisansı eklenmemiştir. Lisans eklenene kadar kodun yeniden dağıtımı veya türev çalışmalar için hak verilmiş sayılmaz.
server.py              FastAPI + WebSocket + Whisper akışı + otomatik yazma
static/index.html      arayüz
static/app.js          mikrofon, WebSocket, arayüz mantığı
static/pcm-worklet.js  16 kHz'ye indirgeme ve paketleme
static/style.css       görünüm
install.sh / run.sh    kurulum ve başlatma
```
