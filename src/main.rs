use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, Write};
use std::path::Path;

// ---------- Date handling ----------

fn is_leap(y: i32) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

#[derive(Clone, Copy)]
struct Date { y: i32, m: u32, d: u32 }

impl Date {
    fn parse(s: &str) -> Option<Date> {
        let p: Vec<&str> = s.split('-').collect();
        if p.len() != 3 { return None; }
        Some(Date {
            y: p[0].parse().ok()?,
            m: p[1].parse().ok()?,
            d: p[2].parse().ok()?,
        })
    }

    fn days_since_epoch(&self) -> i64 {
        static CUM: [u32; 12] = [0,31,59,90,120,151,181,212,243,273,304,334];
        let y = (self.y - 1) as i64;
        let mut days = 365 * y + y / 4 - y / 100 + y / 400;
        days += CUM[(self.m - 1) as usize] as i64;
        if self.m > 2 && is_leap(self.y) { days += 1; }
        days += self.d as i64 - 1;
        days
    }

    fn diff_from(&self, other: Date) -> i64 {
        self.days_since_epoch() - other.days_since_epoch()
    }

    fn cycle_start(today: Date, start_day: u32) -> Date {
        if today.d >= start_day { Date { d: start_day, ..today } }
        else {
            let (y, m) = if today.m == 1 { (today.y - 1, 12) } else { (today.y, today.m - 1) };
            Date { y, m, d: start_day }
        }
    }

    fn next_cycle_start(&self) -> Date {
        let (y, m) = if self.m == 12 { (self.y + 1, 1) } else { (self.y, self.m + 1) };
        Date { y, m, d: self.d }
    }

    fn fmt(&self) -> String { format!("{:04}-{:02}-{:02}", self.y, self.m, self.d) }
    fn to_csv_row(&self) -> String { format!("{},{:02},{}", self.y, self.m, self.d) }
    
    // Quick auto-date from system time (fallback)
    fn today_auto() -> Date {
        // Without chrono, we use a hardcoded fallback; users can override via input
        Date { y: 2026, m: 9, d: 26 }
    }
}

// ---------- Categories ----------
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum Category {
    Groceries,
    EatingOut,
    TransportExtras,
    Entertainment,
    Shopping,
    BillsOther,  // Non-fixed bills, phone credit, etc.
    HealthCare,
    Misc,
}

impl Category {
    fn from_str(s: &str) -> Self {
        match s.to_lowercase().trim() {
            "groc" | "groceries" | "food" => Category::Groceries,
            "eat" | "eating" | "restaurant" | "out" | "dining" => Category::EatingOut,
            "trans" | "transport" | "bus" | "tram" | "metro" => Category::TransportExtras,
            "ent" | "entertainment" | "movie" | "game" => Category::Entertainment,
            "shop" | "shopping" | "clothes" | "stuff" => Category::Shopping,
            "bill" | "bills" | "phone" | "internet" => Category::BillsOther,
            "health" | "care" | "med" | "pharmacy" => Category::HealthCare,
            _ => Category::Misc,
        }
    }
    
    fn display(&self) -> &str {
        match self {
            Category::Groceries => "🛒 Groceries",
            Category::EatingOut => "🍽️ Eating Out",
            Category::TransportExtras => "🚌 Transport Extras",
            Category::Entertainment => "🎬 Entertainment",
            Category::Shopping => "🛍️ Shopping",
            Category::BillsOther => "📄 Bills Other",
            Category::HealthCare => "💊 Healthcare",
            Category::Misc => "❓ Misc",
        }
    }

    fn short_label(&self) -> &str {
        match self {
            Category::Groceries => "groceries",
            Category::EatingOut => "eating_out",
            Category::TransportExtras => "transport",
            Category::Entertainment => "entertainment",
            Category::Shopping => "shopping",
            Category::BillsOther => "bills_other",
            Category::HealthCare => "health",
            Category::Misc => "misc",
        }
    }
}

// ---------- Transaction record ----------
#[derive(Clone)]
struct Tx {
    ts: String,
    amt: f64,
    label: String,
    category: Category,
    cycle_id: String,
    reserved: bool,
}

// ---------- History record ----------
#[derive(Clone)]
struct CycleRecord {
    start: String,
    end: String,
    income: f64,
    fixed: f64,
    buffer: f64,
    opening_balance: f64,
    extra_transport: f64,
    limit: f64,
    spent: f64,
    reserved_for_next: f64,
    carryover_to_next: f64,
    overshoot: bool,
    category_totals: Vec<(String, f64)>, // category_name, amount
}

// ---------- Budget model ----------

const HISTORY_FILE: &str = ".lumo_budget_history.csv";
const HISTORY_HEADER: &str = "start,end,income,fixed,buffer,limit,spent,reserved_next,carryover_next,overshoot,category_data,opening_balance,extra_transport";
const TRANSACTIONS_DIR: &str = ".lumo_transactions";

fn parse_history_row(line: &str) -> Option<CycleRecord> {
    let fields: Vec<&str> = line.split(',').collect();
    if fields.len() < 10 { return None; }

    let category_totals = fields.get(10).map(|data| {
        data.split('|')
            .filter_map(|entry| {
                let (name, amount) = entry.split_once(':')?;
                Some((name.to_string(), amount.parse().ok()?))
            })
            .collect()
    }).unwrap_or_default();

    Some(CycleRecord {
        start: fields[0].to_string(),
        end: fields[1].to_string(),
        income: fields[2].parse().unwrap_or(0.0),
        fixed: fields[3].parse().unwrap_or(0.0),
        buffer: fields[4].parse().unwrap_or(0.0),
        limit: fields[5].parse().unwrap_or(0.0),
        spent: fields[6].parse().unwrap_or(0.0),
        reserved_for_next: fields[7].parse().unwrap_or(0.0),
        carryover_to_next: fields[8].parse().unwrap_or(0.0),
        overshoot: fields[9].contains("true"),
        category_totals,
        opening_balance: fields.get(11).and_then(|v| v.parse().ok()).unwrap_or(0.0),
        extra_transport: fields.get(12).and_then(|v| v.parse().ok()).unwrap_or(0.0),
    })
}

fn upgrade_history_csv() -> io::Result<()> {
    let contents = match fs::read_to_string(HISTORY_FILE) {
        Ok(contents) if !contents.is_empty() => contents,
        _ => return Ok(()),
    };
    let mut lines = contents.lines();
    let header = lines.next().unwrap_or_default();
    if header.contains("opening_balance") { return Ok(()); }

    let temp_path = format!("{}.tmp", HISTORY_FILE);
    let backup_path = format!("{}.bak", HISTORY_FILE);
    {
        let mut upgraded = File::create(&temp_path)?;
        writeln!(upgraded, "{}", HISTORY_HEADER)?;
        for line in lines {
            let legacy_fields = line.split(',').count();
            if legacy_fields == 10 {
                writeln!(upgraded, "{},,0.00,0.00", line)?;
            } else {
                writeln!(upgraded, "{},0.00,0.00", line)?;
            }
        }
    }

    fs::rename(HISTORY_FILE, &backup_path)?;
    if let Err(error) = fs::rename(&temp_path, HISTORY_FILE) {
        let _ = fs::rename(&backup_path, HISTORY_FILE);
        return Err(error);
    }
    fs::remove_file(backup_path)
}

struct Budget {
    income: f64,
    opening_balance: f64,
    fixed: f64,
    buffer: f64,
    extra_transport: f64,
    carryover: f64,
    cycle_start_day: u32,
    today: Date,
    spent: Vec<Tx>,
    reserved_next: Vec<Tx>,
    history: Vec<CycleRecord>,
}

impl Budget {
    fn csv_escape(s: &str) -> String {
        if s.contains(',') || s.contains('"') || s.contains('\n') {
            format!("\"{}\"", s.replace('"', "\"\""))
        } else {
            s.to_string()
        }
    }

    fn save_transaction_csv(&self, tx: &Tx) -> io::Result<()> {
        let path = Path::new(TRANSACTIONS_DIR);
        fs::create_dir_all(path)?;
        
            let file_path = path.join(format!("{}.csv", Date::cycle_start(self.today, self.cycle_start_day).to_csv_row()));
        
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(file_path)?;
        
        writeln!(file, "{},{},{},{},{},{}",
            tx.ts,
            tx.amt,
            Self::csv_escape(&tx.label),
            tx.category.short_label(),
            tx.cycle_id,
            if tx.reserved { "reserved" } else { "active" })
    }

    fn load_history(&mut self) -> io::Result<()> {
        let file = File::open(HISTORY_FILE);
        if let Ok(f) = file {
            let reader = io::BufReader::new(f);
            for (i, line) in reader.lines().enumerate() {
                if i == 0 { continue; } // skip header
                if let Ok(line) = line {
                    if let Some(record) = parse_history_row(&line) {
                        self.history.push(record);
                    }
                }
            }
        }
        Ok(())
    }

    fn load_last_cycle_carrier_over(&self) -> io::Result<f64> {
        if let Some(last) = self.history.iter().rev().next() {
            Ok(last.carryover_to_next)
        } else {
            Ok(0.0)
        }
    }

    fn append_history(&self, rec: &CycleRecord) -> io::Result<()> {
        upgrade_history_csv()?;
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(HISTORY_FILE)?;
        
        if fs::metadata(HISTORY_FILE).map(|m| m.len()).unwrap_or(0) == 0 {
            writeln!(file, "{}", HISTORY_HEADER)?;
        }
        
        let cat_str = rec.category_totals.iter()
            .map(|(n, a)| format!("{}:{:.0}", n, a))
            .collect::<Vec<_>>()
            .join("|");
        
        writeln!(file, "{},{},{:.2},{:.2},{:.2},{:.2},{:.2},{:.2},{:.2},{},{},{:.2},{:.2}",
            rec.start, rec.end, rec.income, rec.fixed, rec.buffer,
            rec.limit, rec.spent, rec.reserved_for_next, rec.carryover_to_next,
            if rec.overshoot { "true" } else { "false" },
            cat_str, rec.opening_balance, rec.extra_transport)
    }

    fn finalize_current_cycle(&self) -> CycleRecord {
        let start = Date::cycle_start(self.today, self.cycle_start_day);
        let end = start.next_cycle_start();
        
        let spent = self.spent.iter().map(|t| t.amt).sum::<f64>();
        let reserved = self.reserved_next.iter().map(|t| t.amt).sum::<f64>();
        let limit = self.cycle_limit();
        
        let carryover = (spent - limit).max(0.0);
        
        // Calculate category totals for this cycle
        let mut cat_map: std::collections::HashMap<Category, f64> = std::collections::HashMap::new();
        for tx in &self.spent {
            *cat_map.entry(tx.category.clone()).or_insert(0.0) += tx.amt;
        }
        for tx in &self.reserved_next {
            *cat_map.entry(tx.category.clone()).or_insert(0.0) += tx.amt;
        }
        
        let category_totals: Vec<(String, f64)> = cat_map.iter()
            .map(|(c, a)| (c.short_label().to_string(), *a))
            .collect();
        
        CycleRecord {
            start: start.fmt(),
            end: end.fmt(),
            income: self.income,
            fixed: self.fixed,
            buffer: self.buffer,
            opening_balance: self.opening_balance,
            extra_transport: self.extra_transport,
            limit,
            spent,
            reserved_for_next: reserved,
            carryover_to_next: carryover,
            overshoot: spent > limit,
            category_totals,
        }
    }

    fn cycle_limit(&self) -> f64 {
        (self.income + self.opening_balance - self.fixed - self.buffer - self.carryover).max(0.0)
    }

    fn cycle_spent(&self) -> f64 { self.spent.iter().map(|t| t.amt).sum() }

    fn remaining(&self) -> f64 { self.cycle_limit() - self.cycle_spent() }

    fn category_breakdown(&self) -> Vec<(Category, f64, f64)> { // (category, spent, pct_of_total)
        let total = self.cycle_spent();
        if total <= 0.0 { return vec![]; }
        
        let mut cat_map: std::collections::HashMap<Category, f64> = std::collections::HashMap::new();
        for tx in &self.spent {
            *cat_map.entry(tx.category.clone()).or_insert(0.0) += tx.amt;
        }
        for tx in &self.reserved_next {
            *cat_map.entry(tx.category.clone()).or_insert(0.0) += tx.amt;
        }
        
        let mut result: Vec<(Category, f64, f64)> = cat_map.iter()
            .map(|(c, a)| (c.clone(), *a, (*a / total) * 100.0))
            .collect();
        result.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
        result
    }

    fn next_cycle_preview(&self) -> f64 {
        (self.income - self.fixed - self.buffer) - self.reserved_next.iter().map(|t| t.amt).sum::<f64>()
    }

    fn show_category_insights(&self) {
        let breakdown = self.category_breakdown();
        if breakdown.is_empty() {
            println!("\n  No transactions yet to analyze.");
            return;
        }

        println!("\n{}", "=".repeat(50));
        println!("CATEGORY SPENDING BREAKDOWN");
        println!("{}", "=".repeat(50));

        println!("\n  {:<25} {:>10} {:>8}", "Category", "Amount", "% Share");
        println!("  {}", "-".repeat(50));

        for (cat, amt, pct) in &breakdown {
            let bar_len = (*pct / 5.0).round() as usize;
            let bar = "█".repeat(bar_len);
            println!("  {:<24} {:>10.0} {:>7.1}% {}",
                     cat.display(), amt, pct, bar);
        }

        // Identify top spender
        if !breakdown.is_empty() {
            let (top_cat, top_amt, _) = &breakdown[0];
            println!("\n  🔥 Top category: {} ({:.0} kr)", top_cat.display(), top_amt);
        }

        // Compare against history (last 3 cycles avg)
        if self.history.len() >= 3 {
            let recent_cats: std::collections::HashMap<String, Vec<f64>> = 
                self.history.iter().rev().take(3)
                    .flat_map(|r| r.category_totals.iter())
                    .fold(std::collections::HashMap::new(), |mut acc, (cat, amt)| {
                        acc.entry(cat.clone()).or_insert_with(Vec::new).push(*amt);
                        acc
                    });
            
            println!("\n  Comparing to last 3 cycles:");
            for (cat, amounts) in &recent_cats {
                let avg = amounts.iter().sum::<f64>() / amounts.len() as f64;
                let current: f64 = breakdown.iter()
                    .filter(|(c, _, _)| c.short_label() == cat)
                    .map(|(_, a, _)| *a).sum();
                
                let diff = current - avg;
                let trend = if diff > 50.0 { "⬆" } else if diff < -50.0 { "⬇" } else { "➡" };
                println!("    {} {}: {:.0} kr now vs {:.0} kr avg {}",
                         trend, cat, current, avg, trend);
            }
        }

        // Warning for high-risk categories
        let risk_cats = ["eating_out", "shopping"];
        for risk in &risk_cats {
            if let Some((_, _, pct)) = breakdown.iter().find(|(c, _, _)| c.short_label() == *risk) {
                if *pct > 30.0 {
                    println!("\n  ⚠ {} is {:.0}% of spending!", 
                             Category::from_str(risk).display(), pct);
                    println!("    Consider reducing discretionary spend in this category.");
                }
            }
        }
    }

    fn show_history(&self) {
        println!("\n{}", "=".repeat(70));
        println!("MONTH-OVER-MONTH CYCLE HISTORY");
        println!("{}", "=".repeat(70));

        if self.history.is_empty() {
            println!("\n  No historical data yet. Complete a full cycle to see here.");
            return;
        }

        println!("\n  {:>12} | {:>9} | {:>9} | {:>9} | {:>9}",
            "Cycle", "Spent", "Limit", "Diff", "Carryover");
        println!("  {}", "-".repeat(60));

        let mut total_overshoot = 0.0;
        let mut total_under = 0.0;
        let mut overshoot_count = 0;
        let mut cycle_count = 0;

        for rec in self.history.iter().rev().take(6) {
            let diff = rec.limit as i64 - rec.spent as i64;
            let status = if rec.overshoot { "🔴" } else { "✅" };
            let diff_str = if diff >= 0 { format!("+{}", diff) } else { format!("-{}", -diff) };
            let end_month = rec.end.split('-').nth(1).unwrap_or("?");

            println!("  {} {:>8} | {:>9.0} | {:>9.0} | {:>9} | {:.0}",
                status, end_month, rec.spent, rec.limit, diff_str, rec.carryover_to_next);

            if rec.overshoot {
                total_overshoot += rec.carryover_to_next;
                overshoot_count += 1;
            } else {
                total_under += diff as f64;
            }
            cycle_count += 1;
        }

        if cycle_count > 0 {
            println!("  {}", "-".repeat(60));
            println!("\n  Summary (last {} cycles):", cycle_count);
            println!("    Overshooting cycles: {}/{} ({:.0}%)",
                     overshoot_count, cycle_count,
                     (overshoot_count as f64 / cycle_count as f64 * 100.0));
            println!("    Total carryover accumulated: {:.0} kr", total_overshoot);
            println!("    Total cushion built: {:.0} kr", total_under);
            
            if total_overshoot > total_under {
                println!("\n  ⚠ NET DEFICIT: {:.0} kr carried forward", total_overshoot - total_under);
            } else if total_under > total_overshoot {
                println!("\n  ✓ NET POSITIVE: {:.0} kr breathing room built", total_under - total_overshoot);
            }
        }

        // Category trends
        if self.history.len() >= 3 {
            let recent: Vec<&CycleRecord> = self.history.iter().rev().take(3).collect();
            let older: Vec<&CycleRecord> = self.history.iter().rev().skip(3).take(3).collect();
            
            let recent_avg = recent.iter().map(|r| r.spent).sum::<f64>() / 3.0;
            let older_avg = older.iter().map(|r| r.spent).sum::<f64>() / older.len() as f64;
            
            let trend = recent_avg - older_avg;
            println!("\n  Spending trend (last 3 vs prior):");
            if trend > 100.0 {
                println!("    ⬆ INCREASING: +{:.0} kr avg per cycle", trend);
            } else if trend < -100.0 {
                println!("    ⬇ DECREASING: {:.0} kr avg per cycle", -trend);
            } else {
                println!("    ➡ STABLE: ~{:.0} kr variance", trend.abs());
            }

            // Show category trend for top spender
            let mut all_recent_cats: std::collections::HashMap<String, Vec<f64>> = std::collections::HashMap::new();
            for rec in &recent {
                for (cat, amt) in &rec.category_totals {
                    all_recent_cats.entry(cat.clone()).or_insert_with(Vec::new).push(*amt);
                }
            }
            let mut all_older_cats: std::collections::HashMap<String, Vec<f64>> = std::collections::HashMap::new();
            for rec in &older {
                for (cat, amt) in &rec.category_totals {
                    all_older_cats.entry(cat.clone()).or_insert_with(Vec::new).push(*amt);
                }
            }

            println!("\n  Top category trends:");
            for (cat, recent_amts) in &all_recent_cats {
                let recent_avg_cat = recent_amts.iter().sum::<f64>() / recent_amts.len() as f64;
                let older_avg_cat = all_older_cats.get(cat)
                    .map(|v| v.iter().sum::<f64>() / v.len() as f64)
                    .unwrap_or(0.0);
                
                let diff = recent_avg_cat - older_avg_cat;
                if diff.abs() > 50.0 {
                    let sign = if diff > 0.0 { "+" } else { "" };
                    println!("    {}: {}{:.0} kr", cat, sign, diff);
                }
            }
        }
    }

    fn status(&self) {
        let start = Date::cycle_start(self.today, self.cycle_start_day);
        let end = start.next_cycle_start();
        let total_days = end.diff_from(start);
        let elapsed = self.today.diff_from(start).max(0);
        let remaining_days = (total_days - elapsed).max(0);

        let limit = self.cycle_limit();
        let spent = self.cycle_spent();
        let remaining = self.remaining();
        let reserved = self.reserved_next.iter().map(|t| t.amt).sum::<f64>();

        let ideal_pace = limit * (elapsed as f64) / (total_days as f64);
        let projected_end = if elapsed > 0 {
            spent / elapsed as f64 * total_days as f64
        } else { 0.0 };

        println!("\n{}", "=".repeat(54));
        println!("CURRENT CYCLE STATUS");
        println!("{}", "=".repeat(54));

        println!("\n  💰 Income (25th)              {:>10.0} kr", self.income);
        if self.opening_balance > 0.0 {
            println!("  + 💵 Previous balance available {:>10.0} kr", self.opening_balance);
        }
        println!("  − 🏠 Fixed costs (next month) {:>10.0} kr", self.fixed);
        println!("  − 🛡️ Buffer                   {:>10.0} kr", self.buffer);
        if self.carryover > 0.0 {
            println!("  − ⚠️ Carryover from last cycle {:>10.0} kr", self.carryover);
        }
        println!("  ──────────────────────────────────────");
        println!("  🎯 Cycle spending limit       {:>10.0} kr", limit);
        println!("  ✅ Spent so far               {:>10.0} kr", spent);
        println!("  ✨ REMAINING                  {:>10.0} kr", remaining);
        println!("  Day {} of {} ({} days left)", elapsed + 1, total_days, remaining_days);
        println!("  Daily allowance left        {:>10.0} kr/day",
                 if remaining_days > 0 { remaining / remaining_days as f64 } else { remaining });

        if reserved > 0.0 {
            println!("\n  🔐 Sparkkonto reserved for next cycle: {:.0} kr", reserved);
            println!("  📅 Next cycle starting budget:       {:.0} kr", self.next_cycle_preview());
        }

        println!("\n  📊 Pacing: spent {:.0} vs ideal {:.0} at this point", spent, ideal_pace);
        if elapsed > 0 {
            if spent > ideal_pace * 1.10 {
                println!("  ⚠️ OVER PACE: projected end ≈ {:.0} kr (limit {:.0})",
                         projected_end, limit);
                let proj_overshoot = (projected_end - limit).max(0.0);
                if proj_overshoot > 0.0 {
                    println!("    → Projected overshoot next cycle: {:.0} kr", proj_overshoot);
                }
            } else {
                println!("  ✓ On or under pace.");
            }
        }

        if remaining < 0.0 {
            println!("\n  🛑 OVER LIMIT by {:.0} kr this cycle!", -remaining);
        }

        // Show category breakdown inline for quick view
        let breakdown = self.category_breakdown();
        if !breakdown.is_empty() && breakdown.len() <= 5 {
            println!("\n  Quick category view:");
            for (cat, amt, pct) in &breakdown {
                println!("    {}: {:.0} kr ({:.0}%)", cat.display(), amt, pct);
            }
        }
    }

    fn list(&self) {
        println!("\nTransactions this cycle:");
        if self.spent.is_empty() && self.reserved_next.is_empty() {
            println!("  (none recorded yet)");
        }
        for t in &self.spent {
            println!("  {:>10.0} kr  [{:<15}] {}  ({})", t.amt, t.category.short_label(), t.label, t.ts);
        }
        for t in &self.reserved_next {
            println!("  {:>10.0} kr  [{:<15}] {}  ({})  [reserved → next cycle]",
                     t.amt, t.category.short_label(), t.label, t.ts);
        }
        println!("\n  Total active: {:.0} kr", self.cycle_spent());
        println!("  Total reserved: {:.0} kr", self.reserved_next.iter().map(|t| t.amt).sum::<f64>());
    }

    fn export_all_transactions(&self) -> io::Result<()> {
        let path = Path::new(".lumo_export_all.csv");
        let mut file = File::create(path)?;
        
        writeln!(file, "timestamp,amount,label,category,cycle_id,status")?;
        
        for tx in &self.spent {
            writeln!(file, "{},{},{},{},{},active",
                tx.ts, tx.amt, Self::csv_escape(&tx.label), tx.category.short_label(), tx.cycle_id)?;
        }
        for tx in &self.reserved_next {
            writeln!(file, "{},{},{},{},{},reserved",
                tx.ts, tx.amt, Self::csv_escape(&tx.label), tx.category.short_label(), tx.cycle_id)?;
        }
        
        println!("✓ Exported all transactions to .lumo_export_all.csv");
        Ok(())
    }

    fn finalize_and_save_cycle(&self) -> io::Result<()> {
        let rec = self.finalize_current_cycle();
        self.append_history(&rec)?;
        println!("✓ Cycle finalized: {:.0} kr spent on {:.0} kr limit.", rec.spent, rec.limit);
        if rec.carryover_to_next > 0.0 {
            println!("  ⚠ Carryover to next cycle: {:.0} kr", rec.carryover_to_next);
            println!("  → Next time, 'auto-carryover' will be set automatically.");
        }
        Ok(())
    }

    fn detect_and_report_high_risk_categories(&self) {
        let breakdown = self.category_breakdown();
        let total = self.cycle_spent();
        if total <= 0.0 { return; }

        let eating_out: f64 = breakdown.iter()
            .filter(|(c, _, _)| *c == Category::EatingOut)
            .map(|(_, a, _)| a).sum();
        let shopping: f64 = breakdown.iter()
            .filter(|(c, _, _)| *c == Category::Shopping)
            .map(|(_, a, _)| a).sum();

        let eating_pct = (eating_out / total) * 100.0;
        let shop_pct = (shopping / total) * 100.0;

        if eating_pct > 25.0 {
            println!("\n  ⚠️ EATING OUT: {:.0}% of spending ({:.0} kr)", eating_pct, eating_out);
            println!("    Tip: Try cooking at home 2-3x/week to save ~100-200 kr/week.");
        }
        if shop_pct > 20.0 {
            println!("\n  ⚠️ SHOPPING: {:.0}% of spending ({:.0} kr)", shop_pct, shopping);
            println!("    Tip: Implement 24-hour rule before non-essential purchases.");
        }
        if total < 500.0 {
            println!("\n  ℹ️ Low activity this cycle. Keep logging to build history!");
        }
    }
}

fn read_num_with_default(prompt: &str, default: Option<f64>) -> f64 {
    loop {
        if let Some(value) = default {
            print!("{} [{:.2}]: ", prompt, value);
        } else {
            print!("{}: ", prompt);
        }
        io::stdout().flush().unwrap();
        let mut s = String::new();
        io::stdin().lock().read_line(&mut s).unwrap();
        if s.trim().is_empty() {
            if let Some(value) = default { return value; }
        } else if let Ok(v) = s.trim().replace(',', ".").parse() {
            return v;
        }
        println!("  Please enter a number.");
    }
}

fn read_date(prompt: &str) -> Date {
    loop {
        print!("{}", prompt);
        io::stdout().flush().unwrap();
        let mut s = String::new();
        io::stdin().lock().read_line(&mut s).unwrap();
        if let Some(d) = Date::parse(s.trim()) { return d; }
        println!("  Use YYYY-MM-DD format.");
    }
}

fn parse_tx_input(line: &str) -> Result<(f64, String, Category), ()> {
    let tokens: Vec<&str> = line.trim().split_whitespace().collect();
    if tokens.is_empty() {
        println!("  Cancelled.");
        return Err(());
    }
    
    // First token is amount, rest is label, optionally ending with category tag
    let amount: f64 = match tokens[0].replace(',', ".").parse() {
        Ok(a) => a,
        Err(_) => {
            println!("  Invalid amount '{}'. Cancelled.", tokens[0]);
            return Err(());
        }
    };
    
    let mut label_parts = Vec::new();
    let mut category_tag: Option<String> = None;
    
    for token in &tokens[1..] {
        let lower = token.to_lowercase();
        if lower.starts_with(":") || lower.starts_with("#") {
            category_tag = Some(lower[1..].to_string());
        } else {
            label_parts.push(token.to_string());
        }
    }
    
    let label = label_parts.join(" ");
    let category = if let Some(tag) = category_tag {
        Category::from_str(&tag)
    } else {
        Category::from_str(&label)  // Auto-detect from label words
    };
    
    Ok((amount, label, category))
}

fn main() {
    println!("=== Credit Card Cycle Budget (SEK) ===");
    println!("Features: Category tagging | Auto-carryover | Trend analysis");
    println!("Salary on 25th pays: just-closed bill + NEXT month's fixed costs\n");

    // First, load any existing history to auto-detect carryover
    let mut temp_budget = Budget {
        income: 0.0,
        opening_balance: 0.0,
        fixed: 0.0,
        buffer: 0.0,
        extra_transport: 0.0,
        carryover: 0.0,
        cycle_start_day: 15,
        today: Date::today_auto(),
        spent: Vec::new(),
        reserved_next: Vec::new(),
        history: Vec::new(),
    };
    
    let _ = temp_budget.load_history();
    let auto_carryover = temp_budget.load_last_cycle_carrier_over().unwrap_or(0.0);
    let saved_inputs = temp_budget.history.last();
    let saved_income = saved_inputs.map(|record| record.income);
    let saved_opening_balance = saved_inputs.map(|record| record.opening_balance);
    let saved_fixed = saved_inputs.map(|record| record.fixed - record.extra_transport);
    let saved_buffer = saved_inputs.map(|record| record.buffer);
    let saved_extra_transport = saved_inputs.map(|record| record.extra_transport);
    
    let initial_carryover_display = if auto_carryover > 0.0 {
        format!("{} (detected from history)", auto_carryover)
    } else {
        "0".to_string()
    };

    let mut b = Budget {
        income: read_num_with_default("Monthly net salary (kr)", saved_income),
        opening_balance: read_num_with_default("Unspent balance from previous month available to spend (kr)", saved_opening_balance),
        fixed: read_num_with_default("Fixed costs paid on the 25th (rent, pass, subs, kr)", saved_fixed),
        buffer: read_num_with_default("Buffer to set aside first (kr)", saved_buffer),
        extra_transport: read_num_with_default("Extra-tickets allowance folded into fixed (kr)", saved_extra_transport),
        carryover: auto_carryover,
        cycle_start_day: 15,
        today: read_date("Today's date (YYYY-MM-DD): "),
        spent: Vec::new(),
        reserved_next: Vec::new(),
        history: temp_budget.history,
    };

    println!("\nℹ️  Auto-carryover: {}.\n", initial_carryover_display);

    b.fixed += b.extra_transport;

    b.status();

    println!("\n{}", "=".repeat(50));
    println!("COMMANDS");
    println!("{}", "=".repeat(50));
    println!("  add <amount> [label] [:category]    Log purchase with category");
    println!("                                    Examples: '89 lunch :eat' or '150 groceries'");
    println!("  reserve <amount> [label] [:category] Sparkkonto for next cycle");
    println!("  list                          Show transactions");
    println!("  status                        Recalculate");
    println!("  categories                    Show category insights & trends");
    println!("  history                       View month-over-month history");
    println!("  export                        Export all transactions to CSV");
    println!("  finalize                      End current cycle, save to history");
    println!("  quit");

    println!("\n📌 Category shortcuts: :groc :eat :trans :ent :shop :bills :health :misc");

    loop {
        print!("\n> ");
        io::stdout().flush().unwrap();
        let mut line = String::new();
        if io::stdin().lock().read_line(&mut line).unwrap() == 0 { break; }
        let line = line.trim();
        if line.is_empty() { continue; }
        let mut parts = line.splitn(2, char::is_whitespace);
        let cmd = parts.next().unwrap_or("");
        let input = parts.next().map(str::trim).filter(|s| !s.is_empty());
        
        match cmd {
            "quit" | "q" => break,
            "add" => {
                if let Some(input) = input {
                    match parse_tx_input(input) {
                        Ok((amt, label, cat)) => {
                            let cycle_start = Date::cycle_start(b.today, b.cycle_start_day);
                            b.spent.push(Tx {
                                ts: b.today.fmt(),
                                amt,
                                label,
                                category: cat.clone(),
                                cycle_id: cycle_start.fmt(),
                                reserved: false,
                            });
                            let tx = b.spent.last().unwrap();
                            match b.save_transaction_csv(tx) {
                                Ok(()) => println!("✅ Logged {:.0} kr ([{:<15}])", amt, cat.short_label()),
                                Err(e) => println!("⚠️ Logged in memory, but failed to save CSV: {}", e),
                            }
                            println!("   Remaining: {:.0} kr", b.remaining());
                        }
                        Err(_) => { /* cancelled */ }
                    }
                } else { println!("Usage: add 89.90 lunch :eat"); }
            }
            "reserve" => {
                if let Some(input) = input {
                    match parse_tx_input(input) {
                        Ok((amt, label, cat)) => {
                            let cycle_start = Date::cycle_start(b.today, b.cycle_start_day);
                            b.reserved_next.push(Tx {
                                ts: b.today.fmt(),
                                amt,
                                label,
                                category: cat.clone(),
                                cycle_id: cycle_start.fmt(),
                                reserved: true,
                            });
                            let tx = b.reserved_next.last().unwrap();
                            match b.save_transaction_csv(tx) {
                                Ok(()) => println!("🔐 Reserved {:.0} kr in sparkkonto ([{:<15}])", amt, cat.short_label()),
                                Err(e) => println!("⚠️ Reserved in memory, but failed to save CSV: {}", e),
                            }
                        }
                        Err(_) => { /* cancelled */ }
                    }
                } else { println!("Usage: reserve 350 shoes :shop"); }
            }
            "list" => b.list(),
            "status" => b.status(),
            "categories" => {
                b.show_category_insights();
                b.detect_and_report_high_risk_categories();
            }
            "history" => b.show_history(),
            "export" => { let _ = b.export_all_transactions(); }
            "finalize" => {
                match b.finalize_and_save_cycle() {
                    Ok(_) => {
                        println!("\n  Next cycle: carryover will be auto-loaded from history.");
                        println!("  Current session: carryover still shows old value until restarted.");
                    },
                    Err(e) => println!("Error: {}", e),
                }
            }
            "help" => {
                println!("\nQuick reference:");
                println!("  add 120 lunch :eat         → 120 kr eating out this cycle");
                println!("  add 85 groceriess :groc    → 85 kr groceries");
                println!("  reserve 500 shoes :shop    → 500 kr reserved for next bill");
                println!("  categories                 → See category breakdown & risks");
            }
            other => println!("Unknown: {} (add/reserve/list/status/categories/history/export/finalize/help/quit)", other),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Budget, Category, Date, Tx, parse_history_row, parse_tx_input};

    #[test]
    fn parses_inline_transaction_arguments() {
        let (amount, label, category) = parse_tx_input("136 coop :groc").unwrap();

        assert_eq!(amount, 136.0);
        assert_eq!(label, "coop");
        assert_eq!(category, Category::Groceries);
    }

    #[test]
    fn parses_transaction_arguments_with_extra_whitespace() {
        let (amount, label, category) = parse_tx_input("  61   coop\t:groc  ").unwrap();

        assert_eq!(amount, 61.0);
        assert_eq!(label, "coop");
        assert_eq!(category, Category::Groceries);
    }

    #[test]
    fn previous_balance_increases_current_cycle_spending_limit() {
        let budget = Budget {
            income: 31_900.0,
            opening_balance: 4_434.0,
            fixed: 28_000.0,
            buffer: 0.0,
            extra_transport: 0.0,
            carryover: 0.0,
            cycle_start_day: 15,
            today: Date { y: 2026, m: 9, d: 26 },
            spent: vec![Tx {
                ts: "2026-09-26".to_string(),
                amt: 3_279.0,
                label: "expenses".to_string(),
                category: Category::Misc,
                cycle_id: "2026-09-15".to_string(),
                reserved: false,
            }],
            reserved_next: vec![],
            history: vec![],
        };

        assert_eq!(budget.cycle_limit(), 8_334.0);
        assert_eq!(budget.remaining(), 5_055.0);
    }

    #[test]
    fn reads_saved_inputs_from_new_history_rows() {
        let record = parse_history_row(
            "2026-09-15,2026-10-15,31900,28000,0,8334,3279,0,0,false,groceries:936,4434,250",
        ).unwrap();

        assert_eq!(record.income, 31_900.0);
        assert_eq!(record.opening_balance, 4_434.0);
        assert_eq!(record.extra_transport, 250.0);
        assert_eq!(record.category_totals, vec![("groceries".to_string(), 936.0)]);
    }

    #[test]
    fn loads_legacy_history_rows_without_new_inputs() {
        let record = parse_history_row(
            "2026-08-15,2026-09-15,31900,28000,0,3900,3279,0,0,false,groceries:936",
        ).unwrap();

        assert_eq!(record.opening_balance, 0.0);
        assert_eq!(record.extra_transport, 0.0);
        assert_eq!(record.category_totals, vec![("groceries".to_string(), 936.0)]);
    }
}