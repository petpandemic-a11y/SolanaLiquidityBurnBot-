// === Main ===
(async () => {
  console.log('🚀 Raydium LP Burn Monitor started');

  // Reload existing
  for (const lpMint of Object.keys(monitoredLPs)) {
    monitorLP(lpMint);
  }

  // Discovery loop
  setInterval(discoverNewPools, 60_000); // every 60s

  // CLI input (helyben futtatva működik, Renderen nem)
  process.stdin.on('data', (d) => handleCommand(d.toString()));
})();

// === Dummy HTTP server Renderhez ===
import http from "http";

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Raydium LP Burn Monitor running\n");
}).listen(PORT, () => {
  console.log(`🌐 HTTP server listening on port ${PORT}`);
});
