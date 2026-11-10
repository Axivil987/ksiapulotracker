// Dane projektu Supabase: Project Settings → API.
// Klucz "anon public" jest publiczny z założenia (dostęp pilnują reguły w bazie).
// NIGDY nie wpisuj tu klucza "service_role".
// Puste wartości = strona działa jako sama mapa, bez kont i rankingów.
window.KSIAPULO_CONFIG = {
  supabaseUrl: "https://ovzvszabzqdiinauuefu.supabase.co",
  // true dopiero po włączeniu providera Google w Supabase (Authentication → Sign In / Providers)
  google: false,
  supabaseAnonKey:"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im92enZzemFienFkaWluYXV1ZWZ1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQyODI3MTUsImV4cCI6MjEwOTg1ODcxNX0.FSr4bChmcIM2RxUOm4YVqkIZbbUKMuvXnarcEIi1P5o",
};
