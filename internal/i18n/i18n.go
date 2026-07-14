// Package i18n translates the short, fixed notification strings cuxdeck
// pushes to phones (Web Push and Telegram) into the language the user
// picked in the panel. Same approach as the web panel: the English text
// is the key, and a missing translation falls back to English, so
// nothing ever ships blank. Dynamic pieces (paths, seat names, durations,
// URLs, version numbers) are concatenated by the caller and pass through
// untranslated; only the fixed words/fragments live here.
package i18n

// T returns the translation of English string s for lang, or s itself
// for English / an unknown language / a missing key.
func T(lang, s string) string {
	if lang == "" || lang == "en" {
		return s
	}
	if tbl, ok := dict[lang]; ok {
		if v, ok := tbl[s]; ok {
			return v
		}
	}
	return s
}

type table = map[string]string

var dict = map[string]table{
	"tr": {
		"API trouble — retrying":                             "API sorunu — yeniden deneniyor",
		"All limits hit — waiting for reset":                 "Tüm limitler doldu — sıfırlanma bekleniyor",
		"Recovered — back to work":                           "Toparlandı — işe geri dönüldü",
		"Limits reset — resumed":                             "Limitler sıfırlandı — devam edildi",
		"Session finished":                                   "Oturum bitti",
		"A seat needs re-login":                              "Bir koltuk yeniden giriş istiyor",
		"Sign in again on the computer to keep the pool full": "Havuzu dolu tutmak için bilgisayarda tekrar giriş yap",
		"Every seat is exhausted":                            "Tüm koltuklar tükendi",
		" · seat ":                                           " · koltuk ",
		" · ran ":                                            " · çalıştı ",
		"Waiting for a window to reset":                      "Bir pencerenin sıfırlanması bekleniyor",
		"Frees up in ":                                       "Şu süre sonra boşalır: ",
		"cuxdeck update available":                           "cuxdeck güncellemesi mevcut",
		" — open cuxdeck to install":                         " — kurmak için cuxdeck'i aç",
		"cuxdeck moved — new address":                        "cuxdeck taşındı — yeni adres",
	},
	"fr": {
		"API trouble — retrying":                             "Problème d'API — nouvelle tentative",
		"All limits hit — waiting for reset":                 "Toutes les limites atteintes — attente de réinitialisation",
		"Recovered — back to work":                           "Rétabli — reprise du travail",
		"Limits reset — resumed":                             "Limites réinitialisées — repris",
		"Session finished":                                   "Session terminée",
		"A seat needs re-login":                              "Un siège doit se reconnecter",
		"Sign in again on the computer to keep the pool full": "Reconnectez-vous sur l'ordinateur pour garder le pool complet",
		"Every seat is exhausted":                            "Tous les sièges sont épuisés",
		" · seat ":                                           " · siège ",
		" · ran ":                                            " · a duré ",
		"Waiting for a window to reset":                      "En attente de la réinitialisation d'une fenêtre",
		"Frees up in ":                                       "Se libère dans ",
		"cuxdeck update available":                           "Mise à jour cuxdeck disponible",
		" — open cuxdeck to install":                         " — ouvrez cuxdeck pour installer",
		"cuxdeck moved — new address":                        "cuxdeck a changé d'adresse",
	},
	"de": {
		"API trouble — retrying":                             "API-Problem — erneuter Versuch",
		"All limits hit — waiting for reset":                 "Alle Limits erreicht — warte auf Zurücksetzung",
		"Recovered — back to work":                           "Erholt — zurück an die Arbeit",
		"Limits reset — resumed":                             "Limits zurückgesetzt — fortgesetzt",
		"Session finished":                                   "Sitzung beendet",
		"A seat needs re-login":                              "Ein Platz muss sich neu anmelden",
		"Sign in again on the computer to keep the pool full": "Melden Sie sich am Rechner erneut an, um den Pool voll zu halten",
		"Every seat is exhausted":                            "Alle Plätze sind erschöpft",
		" · seat ":                                           " · Platz ",
		" · ran ":                                            " · lief ",
		"Waiting for a window to reset":                      "Warte auf das Zurücksetzen eines Fensters",
		"Frees up in ":                                       "Wird frei in ",
		"cuxdeck update available":                           "cuxdeck-Update verfügbar",
		" — open cuxdeck to install":                         " — öffnen Sie cuxdeck zur Installation",
		"cuxdeck moved — new address":                        "cuxdeck umgezogen — neue Adresse",
	},
	"it": {
		"API trouble — retrying":                             "Problema API — nuovo tentativo",
		"All limits hit — waiting for reset":                 "Tutti i limiti raggiunti — in attesa di reset",
		"Recovered — back to work":                           "Ripristinato — di nuovo al lavoro",
		"Limits reset — resumed":                             "Limiti azzerati — ripreso",
		"Session finished":                                   "Sessione terminata",
		"A seat needs re-login":                              "Una postazione deve riautenticarsi",
		"Sign in again on the computer to keep the pool full": "Accedi di nuovo sul computer per mantenere pieno il pool",
		"Every seat is exhausted":                            "Tutte le postazioni sono esaurite",
		" · seat ":                                           " · postazione ",
		" · ran ":                                            " · durata ",
		"Waiting for a window to reset":                      "In attesa del reset di una finestra",
		"Frees up in ":                                       "Si libera tra ",
		"cuxdeck update available":                           "Aggiornamento cuxdeck disponibile",
		" — open cuxdeck to install":                         " — apri cuxdeck per installare",
		"cuxdeck moved — new address":                        "cuxdeck si è spostato — nuovo indirizzo",
	},
}
