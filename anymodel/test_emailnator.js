const { CamoufoxEmailnator } = require("../freemodel/lib/camoufox-emailnator-client");

async function main() {
  const mailer = new CamoufoxEmailnator({ headless: false, log: m => console.log(m) });
  await mailer.start();

  console.log("=== Создаём email ===");
  const { email } = await mailer.create();
  console.log("Email:", email);

  console.log(`\n=== Ждём письмо на ${email} (таймаут 300с) ===`);
  console.log("Отправь любое письмо на этот адрес!\n");

  const result = await mailer.waitOtp({ timeout: 300, poll: 5, fromHint: "" });
  console.log("Результат:", JSON.stringify(result, null, 2));

  await mailer.stop();
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
