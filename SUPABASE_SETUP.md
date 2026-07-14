# Supabase Kurulum Checklist

Bu repo için Supabase tarafında yapman gerekenler burada toplanıyor.

## 1. Project oluştur

- Supabase Dashboard'da yeni bir proje aç.
- Proje adını `samet-watchparty` gibi sabit bir isimle tut.
- Yeni kullanıcı kaydını kapat; yalnızca mevcut iki hesabın giriş yapmasına izin ver.

## 2. Auth ayarları

- `Email + Password` ile başla.
- İki kullanıcı hesabını Dashboard üzerinden manuel oluştur.
- Extension içine yalnızca publishable/anon key koy; `service_role` veya secret key kullanma.

## 3. Environment değişkenleri

- Extension app için `VITE_SUPABASE_URL` ve `VITE_SUPABASE_ANON_KEY` ayarla.
- Bu değerler build zamanında okunacak.

## 4. Migration'ları çalıştır

Repo içinde ilk şema zaten hazır:

- `supabase/migrations/001_initial_schema.sql`

Bu migration şunları kuruyor:

- `profiles`
- `rooms`
- `room_members`
- `watch_sessions`
- `playback_states`
- `messages`
- `message_reads`
- RLS politikaları
- `create_room(p_name, p_member_id)` RPC

## 5. RLS politikalarını kontrol et

- Her tablo için RLS açık olmalı.
- Kural şu olmalı: bir kullanıcı yalnızca üyesi olduğu odanın verisini görebilmeli.
- `messages`, `watch_sessions` ve `playback_states` için select/insert/update politikaları bu üyelik kontrolüne dayanmalı.

## 6. Realtime kurulum

- Kalıcı veri için Postgres kullan.
- Video kontrol event'leri için Broadcast kanalını kullan.
- Online durum için Presence kullan.
- Kanal adı formatını `room:<room_id>` olarak sabitle.
- Realtime Settings içinden **Allow public access** ayarını kapat. Aksi halde
  `realtime.messages` RLS politikaları private kanal erişimini koruyamaz.

## 7. Private channel yetkisi

- Realtime kanalına bağlanan kullanıcının JWT'si doğrulanmalı.
- Kanal erişimi yalnızca oda üyesi ise verilmeli.
- Chat için tablo değişikliklerini private channel üzerinden yayınla; playback event'lerini ise doğrudan Broadcast ile gönder.

## 8. Oda akışı

- Supabase Auth hesaplarını yalnızca sen ve arkadaşın için manuel oluştur.
- Her kullanıcı diğer onaylı kullanıcıların profilini görebilir.
- Oda oluştururken arkadaşını seç ve `create_room(p_name, p_member_id)` RPC
  çağrısını yap. RPC iki kullanıcıyı aynı transaction'da odaya ekler.
- Başka bir kullanıcının odaya sonradan katılabileceği bir davet kodu veya
  `join_room` akışı yoktur.

## 9. İlk test senaryoları

- Bir kullanıcı diğer onaylı profili görebiliyor mu.
- Bir kullanıcı arkadaşını seçerek oda oluşturabiliyor mu.
- Oda yalnızca seçilen iki kullanıcı tarafından görülebiliyor mu.
- Oda üyesi olmayan kullanıcı mesajları okuyamıyor mu.
- Broadcast event'leri chat geçmişine yazılmadan anlık geliyor mu.

## 10. Sonraki iyi adım

- `watch_sessions` için ilk `active`/`ended` akışını ekle.
- `playback_states` snapshot güncellemesini 10-15 saniyelik aralıkla bağla.
- Presence payload'ına `videoDetected` ve `sessionId` alanlarını ekle.
