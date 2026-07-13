// Package notify is the shared vocabulary for outbound alerts: a small
// event and the interface every channel (Web Push, Telegram, …)
// implements. Keeping it standalone lets the watcher fan one event out
// to every enabled channel without any of them importing each other.
package notify

// Event is one alert. Tag collapses repeats of the same kind on
// channels that support it (Web Push).
type Event struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	Tag   string `json:"tag"`
}

// Notifier is one delivery channel. Has reports whether it has anyone
// to deliver to, so the watcher can skip work when every channel is
// empty.
type Notifier interface {
	Notify(Event)
	Has() bool
}
