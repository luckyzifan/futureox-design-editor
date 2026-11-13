//! Completion receipts for GPU resource lifetime.
//!
//! The browser renderer owns WebGPU objects. This module is the shared
//! decision for when a pooled texture may be destroyed, when a retired upload
//! is due, and what device loss is allowed to forget. It does not allocate
//! device memory or change a working-set budget.

/// A pooled texture is reclaimable only when its encode epoch is known and
/// `epoch > completed` is false. An unknown epoch stays in flight. This is the
/// same comparison the renderer used before the owner was extracted.
pub fn pool_epoch_reclaimable(has_epoch: bool, epoch: f64, completed: f64) -> bool {
    has_epoch && !(epoch > completed)
}

/// A retired upload or kernel may be destroyed when it is no longer strictly
/// after the completed epoch. `NaN` matches JavaScript `!(epoch > completed)`.
pub fn retired_upload_due(epoch: f64, completed: f64) -> bool {
    !(epoch > completed)
}

/// Device loss drops owner identity. It does not free charged bytes. A
/// non-integer, negative, or non-finite total is rejected so the caller cannot
/// record the loss itself as a release.
pub fn device_loss_owner_reset(charged_bytes: f64) -> f64 {
    if charged_bytes.is_finite() && charged_bytes >= 0.0 && charged_bytes.fract() == 0.0 {
        charged_bytes
    } else {
        f64::NAN
    }
}

/// Indices of completed free-pool duplicates that may be destroyed.
///
/// Pinned entries and unknown or still-newer epochs stay. Among reclaimable
/// entries, the two greatest ages stay so the next identical allocation can
/// reuse them. Drop indices follow that oldest-first order. Unequal input
/// lengths or an unproven completion destroy nothing.
pub fn select_completed_pool_drops(
    has_epoch: &[u8],
    epochs: &[f64],
    ages: &[f64],
    pinned: &[u8],
    completed: f64,
) -> Vec<u32> {
    let count = epochs.len();
    if has_epoch.len() != count || ages.len() != count || pinned.len() != count {
        return Vec::new();
    }
    if !(completed.is_finite() && completed >= 0.0 && completed.fract() == 0.0) {
        return Vec::new();
    }
    let mut ready = Vec::new();
    for index in 0..count {
        if pinned[index] != 0 {
            continue;
        }
        if !pool_epoch_reclaimable(has_epoch[index] != 0, epochs[index], completed) {
            continue;
        }
        ready.push(index);
    }
    ready.sort_by(|&left, &right| {
        ages[left]
            .partial_cmp(&ages[right])
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    if ready.len() <= 2 {
        return Vec::new();
    }
    ready[..ready.len() - 2]
        .iter()
        .filter_map(|index| u32::try_from(*index).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reclaim_requires_a_known_epoch_that_is_not_newer_than_completion() {
        assert!(!pool_epoch_reclaimable(false, 3.0, 3.0));
        assert!(!pool_epoch_reclaimable(true, 4.0, 3.0));
        assert!(pool_epoch_reclaimable(true, 3.0, 3.0));
        assert!(pool_epoch_reclaimable(true, 0.0, 0.0));
        // JavaScript `NaN > completed` is false, so a present NaN epoch is not
        // treated as unknown. Unknown is `has_epoch == false`.
        assert!(pool_epoch_reclaimable(true, f64::NAN, 3.0));
    }

    #[test]
    fn retired_upload_uses_the_javascript_epoch_comparison() {
        assert!(!retired_upload_due(4.0, 3.0));
        assert!(retired_upload_due(3.0, 3.0));
        assert!(retired_upload_due(f64::NAN, -1.0));
        assert!(!retired_upload_due(f64::INFINITY, 9.0));
    }

    #[test]
    fn device_loss_preserves_an_integer_charge_and_rejects_a_corrupt_total() {
        assert_eq!(device_loss_owner_reset(0.0), 0.0);
        assert_eq!(device_loss_owner_reset(192.0), 192.0);
        assert!(device_loss_owner_reset(-1.0).is_nan());
        assert!(device_loss_owner_reset(1.5).is_nan());
        assert!(device_loss_owner_reset(f64::NAN).is_nan());
        assert!(device_loss_owner_reset(f64::INFINITY).is_nan());
    }

    #[test]
    fn completed_duplicates_drop_oldest_first_and_keep_two_plus_inflight() {
        let has_epoch = [1, 1, 1, 1, 1];
        let epochs = [3.0, 3.0, 3.0, 3.0, 4.0];
        let ages = [1.0, 2.0, 3.0, 4.0, 5.0];
        let pinned = [0, 0, 0, 0, 0];
        assert_eq!(
            select_completed_pool_drops(&has_epoch, &epochs, &ages, &pinned, 3.0),
            vec![0, 1]
        );
    }

    #[test]
    fn pinned_unknown_and_short_pools_are_not_destroyed() {
        assert!(
            select_completed_pool_drops(
                &[1, 1, 1],
                &[1.0, 1.0, 1.0],
                &[1.0, 2.0, 3.0],
                &[1, 0, 0],
                1.0
            )
            .is_empty()
        );
        assert_eq!(
            select_completed_pool_drops(
                &[1, 1, 1, 1],
                &[1.0, 1.0, 1.0, 1.0],
                &[9.0, 1.0, 2.0, 3.0],
                &[1, 0, 0, 0],
                1.0
            ),
            vec![1]
        );
        assert!(
            select_completed_pool_drops(&[0, 1], &[9.0, 1.0], &[1.0, 2.0], &[0, 0], 1.0).is_empty()
        );
        assert!(
            select_completed_pool_drops(&[1, 1], &[1.0, 1.0], &[1.0, 2.0], &[0, 0], 1.0).is_empty()
        );
        assert!(select_completed_pool_drops(&[1], &[1.0], &[1.0], &[0], f64::NAN).is_empty());
        assert!(select_completed_pool_drops(&[1], &[1.0], &[1.0], &[], 1.0).is_empty());
    }

    #[test]
    fn equal_ages_keep_the_later_stable_order() {
        let has_epoch = [1, 1, 1, 1];
        let epochs = [1.0, 1.0, 1.0, 1.0];
        let ages = [5.0, 5.0, 5.0, 1.0];
        let pinned = [0, 0, 0, 0];
        assert_eq!(
            select_completed_pool_drops(&has_epoch, &epochs, &ages, &pinned, 1.0),
            vec![3, 0]
        );
    }
}
