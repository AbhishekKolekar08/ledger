#[unsafe(no_mangle)]
pub extern "C" fn cycle_limit_cents(
    income: i64,
    opening_balance: i64,
    fixed_costs: i64,
    buffer: i64,
    carryover: i64,
) -> i64 {
    income
        .saturating_add(opening_balance)
        .saturating_sub(fixed_costs)
        .saturating_sub(buffer)
        .saturating_sub(carryover)
        .max(0)
}

#[unsafe(no_mangle)]
pub extern "C" fn remaining_cents(cycle_limit: i64, spent: i64) -> i64 {
    cycle_limit.saturating_sub(spent)
}

#[cfg(test)]
mod tests {
    use super::{cycle_limit_cents, remaining_cents};

    #[test]
    fn includes_unspent_opening_balance() {
        let limit = cycle_limit_cents(3_190_000, 443_400, 2_800_000, 0, 0);
        assert_eq!(limit, 833_400);
        assert_eq!(remaining_cents(limit, 327_900), 505_500);
    }

    #[test]
    fn cycle_limit_never_drops_below_zero() {
        assert_eq!(cycle_limit_cents(100, 0, 200, 0, 0), 0);
    }
}