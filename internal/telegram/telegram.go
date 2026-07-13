// Package telegram delivers the same alerts as Web Push to a Telegram
// chat — useful for a channel that outlives any one phone. The flow is
// deliberately tiny: the user makes a bot with BotFather, pastes the
// token, and sends the bot a message; cuxdeck catches the chat id from
// getUpdates and remembers it. From then on every event is a
// sendMessage. Token + chat id live under ~/.cuxdeck.
package telegram

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/centrual/cuxdeck/internal/notify"
)

type state struct {
	Token  string `json:"token"`
	ChatID int64  `json:"chatId"`
	Offset int64  `json:"offset"` // getUpdates cursor
}

// Store holds the bot token and resolved chat id.
type Store struct {
	dir  string
	mu   sync.Mutex
	st   state
	http *http.Client
}

func Open(dir string) *Store {
	s := &Store{dir: dir, http: &http.Client{Timeout: 15 * time.Second}}
	if b, err := os.ReadFile(s.path()); err == nil {
		_ = json.Unmarshal(b, &s.st)
	}
	return s
}

func (s *Store) path() string { return filepath.Join(s.dir, "telegram.json") }

func (s *Store) save() {
	b, _ := json.Marshal(s.st)
	_ = os.MkdirAll(s.dir, 0o700)
	_ = os.WriteFile(s.path(), b, 0o600)
}

// Connected reports whether both a token and a chat id are known.
func (s *Store) Connected() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.st.Token != "" && s.st.ChatID != 0
}

// Status is the panel-facing view of the connection.
func (s *Store) Status() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return map[string]any{"hasToken": s.st.Token != "", "linked": s.st.ChatID != 0}
}

// SetToken saves a bot token (validated by a getMe call) and clears any
// stale chat id so the next /start re-links.
func (s *Store) SetToken(ctx context.Context, token string) error {
	if _, err := s.call(ctx, token, "getMe", nil); err != nil {
		return fmt.Errorf("telegram: that token was rejected")
	}
	s.mu.Lock()
	s.st = state{Token: token}
	s.save()
	s.mu.Unlock()
	return nil
}

// Disconnect forgets the token and chat id.
func (s *Store) Disconnect() {
	s.mu.Lock()
	s.st = state{}
	s.save()
	s.mu.Unlock()
}

// Poll drains getUpdates once, capturing the chat id from the first
// message the user sends the bot. Returns true once linked. The panel
// calls this a few times after the user taps "/start".
func (s *Store) Poll(ctx context.Context) (bool, error) {
	s.mu.Lock()
	token, offset, linked := s.st.Token, s.st.Offset, s.st.ChatID != 0
	s.mu.Unlock()
	if token == "" {
		return false, fmt.Errorf("telegram: no token yet")
	}
	if linked {
		return true, nil
	}
	body, err := s.call(ctx, token, "getUpdates", url.Values{
		"offset":  {fmt.Sprint(offset)},
		"timeout": {"0"},
	})
	if err != nil {
		return false, err
	}
	var res struct {
		Result []struct {
			UpdateID int64 `json:"update_id"`
			Message  struct {
				Chat struct {
					ID int64 `json:"id"`
				} `json:"chat"`
			} `json:"message"`
		} `json:"result"`
	}
	if json.Unmarshal(body, &res) != nil {
		return false, fmt.Errorf("telegram: bad response")
	}
	for _, u := range res.Result {
		s.mu.Lock()
		s.st.Offset = u.UpdateID + 1
		if s.st.ChatID == 0 && u.Message.Chat.ID != 0 {
			s.st.ChatID = u.Message.Chat.ID
		}
		s.save()
		linked = s.st.ChatID != 0
		s.mu.Unlock()
	}
	if linked {
		_ = s.send(ctx, "✅ cuxdeck linked — you'll get fleet alerts here.")
	}
	return linked, nil
}

// Has satisfies notify.Notifier — true only when fully linked.
func (s *Store) Has() bool { return s.Connected() }

// Notify sends an event as a Telegram message (best-effort).
func (s *Store) Notify(ev notify.Event) {
	if !s.Connected() {
		return
	}
	msg := "*" + ev.Title + "*"
	if ev.Body != "" {
		msg += "\n" + ev.Body
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	_ = s.send(ctx, msg)
}

func (s *Store) send(ctx context.Context, text string) error {
	s.mu.Lock()
	token, chat := s.st.Token, s.st.ChatID
	s.mu.Unlock()
	if token == "" || chat == 0 {
		return fmt.Errorf("telegram: not linked")
	}
	_, err := s.call(ctx, token, "sendMessage", url.Values{
		"chat_id":    {fmt.Sprint(chat)},
		"text":       {text},
		"parse_mode": {"Markdown"},
	})
	return err
}

// call hits one Bot API method. A non-ok payload is an error.
func (s *Store) call(ctx context.Context, token, method string, form url.Values) ([]byte, error) {
	endpoint := "https://api.telegram.org/bot" + token + "/" + method
	var req *http.Request
	var err error
	if form != nil {
		req, err = http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewBufferString(form.Encode()))
		if req != nil {
			req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		}
	} else {
		req, err = http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	}
	if err != nil {
		return nil, err
	}
	resp, err := s.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	buf := new(bytes.Buffer)
	_, _ = buf.ReadFrom(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("telegram: %s", resp.Status)
	}
	return buf.Bytes(), nil
}
