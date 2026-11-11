use std::sync::OnceLock;

const EMBEDDED_MHR: &[u8] = include_bytes!("../../assets/hrtf/sadie-ii-d1-48000.mhr");
const MHR_MAGIC: &[u8; 8] = b"MinPHR03";
const MAX_HRIR_COUNT: usize = 50_000;
const RESAMPLE_RADIUS: isize = 12;

#[derive(Debug)]
struct HrtfDataset {
    sample_rate: u32,
    fields: Vec<HrtfField>,
}

#[derive(Debug)]
struct HrtfField {
    distance_mm: u16,
    elevations: Vec<HrtfElevation>,
}

#[derive(Debug)]
struct HrtfElevation {
    degrees: f32,
    responses: Vec<Hrir>,
}

#[derive(Debug)]
struct Hrir {
    taps: Vec<[f32; 2]>,
    delay_samples: [f32; 2],
}

#[derive(Clone, Debug)]
struct EarResponse {
    taps: Vec<f32>,
    delay_samples: f32,
}

#[derive(Clone, Debug)]
struct BinauralResponse {
    left: EarResponse,
    right: EarResponse,
}

pub(super) struct HrtfRenderer {
    mono_left: BinauralResponse,
    mono_right: BinauralResponse,
    left_source: BinauralResponse,
    right_source: BinauralResponse,
    mono_history: Vec<f32>,
    left_history: Vec<f32>,
    right_history: Vec<f32>,
    cursor: usize,
}

impl HrtfDataset {
    fn parse(bytes: &[u8]) -> Result<Self, String> {
        let mut reader = MhrReader::new(bytes);
        if reader.take(8)? != MHR_MAGIC {
            return Err("بيانات HRTF المضمّنة لا تحمل ترويسة MHR v3 صحيحة".into());
        }

        let sample_rate = reader.u32()?;
        if !(8_000..=384_000).contains(&sample_rate) {
            return Err(format!("معدل عينات HRTF غير مدعوم: {sample_rate}"));
        }
        let channel_type = reader.u8()?;
        if channel_type > 1 {
            return Err(format!("نوع قنوات HRIR غير مدعوم: {channel_type}"));
        }
        let hrir_size = usize::from(reader.u8()?);
        if !(8..=128).contains(&hrir_size) {
            return Err(format!("حجم HRIR غير مدعوم: {hrir_size}"));
        }
        let field_count = usize::from(reader.u8()?);
        if !(1..=16).contains(&field_count) {
            return Err(format!("عدد حقول مسافة HRTF غير مدعوم: {field_count}"));
        }

        let mut fields = Vec::with_capacity(field_count);
        let mut previous_distance = u16::MAX;
        let mut total_hrirs = 0usize;
        for field_index in 0..field_count {
            let distance_mm = reader.u16()?;
            if !(50..=2_500).contains(&distance_mm) {
                return Err(format!("مسافة حقل HRTF خارج النطاق: {distance_mm} mm"));
            }
            if field_index > 0 && distance_mm >= previous_distance {
                return Err("حقول مسافة HRTF يجب أن تكون مرتبة من الأبعد إلى الأقرب".into());
            }
            previous_distance = distance_mm;

            let elevation_count = usize::from(reader.u8()?);
            if !(5..=181).contains(&elevation_count) {
                return Err(format!("عدد زوايا الارتفاع غير مدعوم: {elevation_count}"));
            }
            let azimuth_counts = reader
                .take(elevation_count)?
                .iter()
                .map(|value| usize::from(*value))
                .collect::<Vec<_>>();
            if azimuth_counts
                .iter()
                .any(|count| !(1..=255).contains(count))
            {
                return Err("عدد قياسات السمت في مجموعة HRTF خارج النطاق".into());
            }
            for count in &azimuth_counts {
                total_hrirs = total_hrirs
                    .checked_add(*count)
                    .ok_or_else(|| "تجاوز عدد قياسات HRIR الحد المسموح".to_string())?;
            }
            if total_hrirs > MAX_HRIR_COUNT {
                return Err("مجموعة HRTF أكبر من الحد الآمن المدعوم".into());
            }

            let denominator = (elevation_count - 1) as f32;
            let mut elevations = Vec::with_capacity(elevation_count);
            for (index, azimuth_count) in azimuth_counts.into_iter().enumerate() {
                let degrees = -90.0 + 180.0 * index as f32 / denominator;
                let mut responses = Vec::with_capacity(azimuth_count);
                for _ in 0..azimuth_count {
                    let mut taps = Vec::with_capacity(hrir_size);
                    for _ in 0..hrir_size {
                        let left = reader.i24()? as f32 / 8_388_608.0;
                        let right = if channel_type == 1 {
                            reader.i24()? as f32 / 8_388_608.0
                        } else {
                            0.0
                        };
                        taps.push([left, right]);
                    }
                    responses.push(Hrir {
                        taps,
                        delay_samples: [0.0; 2],
                    });
                }
                elevations.push(HrtfElevation { degrees, responses });
            }
            fields.push(HrtfField {
                distance_mm,
                elevations,
            });
        }

        for field in &mut fields {
            for elevation in &mut field.elevations {
                for response in &mut elevation.responses {
                    response.delay_samples[0] = f32::from(reader.u8()?) / 4.0;
                    if channel_type == 1 {
                        response.delay_samples[1] = f32::from(reader.u8()?) / 4.0;
                    }
                }
            }
        }

        if channel_type == 0 {
            for field in &mut fields {
                for elevation in &mut field.elevations {
                    let azimuth_count = elevation.responses.len();
                    let measured_left = elevation
                        .responses
                        .iter()
                        .map(|response| {
                            (
                                response.taps.iter().map(|tap| tap[0]).collect::<Vec<_>>(),
                                response.delay_samples[0],
                            )
                        })
                        .collect::<Vec<_>>();
                    for (azimuth_index, response) in elevation.responses.iter_mut().enumerate() {
                        let mirrored_index = (azimuth_count - azimuth_index) % azimuth_count;
                        let (mirrored_taps, mirrored_delay) = &measured_left[mirrored_index];
                        for (tap, value) in response.taps.iter_mut().zip(mirrored_taps) {
                            tap[1] = *value;
                        }
                        response.delay_samples[1] = *mirrored_delay;
                    }
                }
            }
        }

        if !reader.is_empty() {
            return Err("بيانات MHR المضمّنة تحتوي بايتات زائدة غير متوقعة".into());
        }
        Ok(Self {
            sample_rate,
            fields,
        })
    }

    #[cfg(test)]
    fn hrir_count(&self) -> usize {
        self.fields
            .iter()
            .flat_map(|field| &field.elevations)
            .map(|elevation| elevation.responses.len())
            .sum()
    }

    fn response(
        &self,
        clockwise_azimuth_degrees: f32,
        elevation_degrees: f32,
        target_rate: u32,
    ) -> Result<BinauralResponse, String> {
        let field = self
            .fields
            .iter()
            .min_by_key(|field| field.distance_mm.abs_diff(1_200))
            .ok_or_else(|| "لا توجد حقول مسافة في مجموعة HRTF".to_string())?;
        let elevation = field
            .elevations
            .iter()
            .min_by(|a, b| {
                (a.degrees - elevation_degrees)
                    .abs()
                    .total_cmp(&(b.degrees - elevation_degrees).abs())
            })
            .ok_or_else(|| "لا توجد قياسات ارتفاع في مجموعة HRTF".to_string())?;
        let count = elevation.responses.len();
        if count == 0 {
            return Err("مجموعة HRTF لا تحتوي قياسات سمت".into());
        }
        let azimuth = clockwise_azimuth_degrees.rem_euclid(360.0);
        let azimuth_index = ((azimuth / 360.0 * count as f32).round() as usize) % count;
        let hrir = &elevation.responses[azimuth_index];
        let left_taps = hrir.taps.iter().map(|tap| tap[0]).collect::<Vec<_>>();
        let right_taps = hrir.taps.iter().map(|tap| tap[1]).collect::<Vec<_>>();
        let scale = target_rate as f32 / self.sample_rate as f32;
        Ok(BinauralResponse {
            left: EarResponse {
                taps: resample_taps(&left_taps, self.sample_rate, target_rate),
                delay_samples: hrir.delay_samples[0] * scale,
            },
            right: EarResponse {
                taps: resample_taps(&right_taps, self.sample_rate, target_rate),
                delay_samples: hrir.delay_samples[1] * scale,
            },
        })
    }
}

impl HrtfRenderer {
    pub(super) fn new(sample_rate: u32) -> Result<Self, String> {
        if !(8_000..=384_000).contains(&sample_rate) {
            return Err(format!(
                "معدل عينات التلاوة غير مدعوم لمسار HRTF: {sample_rate}"
            ));
        }
        let dataset = embedded_dataset()?;
        // A mono recitation is spread gently across two measured near-center
        // speaker directions; this keeps the image centered without synthetic taps.
        let mono_left = dataset.response(348.0, 0.0, sample_rate)?;
        let mono_right = dataset.response(12.0, 0.0, sample_rate)?;
        // Stereo recitations are rendered as two virtual loudspeakers at the
        // conventional ±30° stereo positions, using measured SADIE II HRIRs.
        let left_source = dataset.response(330.0, 0.0, sample_rate)?;
        let right_source = dataset.response(30.0, 0.0, sample_rate)?;
        let maximum_taps = [&mono_left, &mono_right, &left_source, &right_source]
            .into_iter()
            .flat_map(|response| [&response.left, &response.right])
            .map(|ear| ear.taps.len())
            .max()
            .unwrap_or(1);
        let maximum_delay = [&mono_left, &mono_right, &left_source, &right_source]
            .into_iter()
            .flat_map(|response| [response.left.delay_samples, response.right.delay_samples])
            .fold(0.0_f32, f32::max)
            .ceil() as usize;
        let history_len = maximum_taps
            .saturating_add(maximum_delay)
            .saturating_add(2)
            .max(2);
        Ok(Self {
            mono_left,
            mono_right,
            left_source,
            right_source,
            mono_history: vec![0.0; history_len],
            left_history: vec![0.0; history_len],
            right_history: vec![0.0; history_len],
            cursor: 0,
        })
    }

    pub(super) fn process(&mut self, left: f32, right: f32, mono_input: bool) -> (f32, f32) {
        let cursor = self.cursor;
        let (out_left, out_right) = if mono_input {
            self.mono_history[cursor] = 0.5 * (left + right);
            let out_left = convolve(&self.mono_history, cursor, &self.mono_left.left)
                + convolve(&self.mono_history, cursor, &self.mono_right.left);
            let out_right = convolve(&self.mono_history, cursor, &self.mono_left.right)
                + convolve(&self.mono_history, cursor, &self.mono_right.right);
            (0.5 * out_left, 0.5 * out_right)
        } else {
            self.left_history[cursor] = left;
            self.right_history[cursor] = right;
            let out_left = convolve(&self.left_history, cursor, &self.left_source.left)
                + convolve(&self.right_history, cursor, &self.right_source.left);
            let out_right = convolve(&self.left_history, cursor, &self.left_source.right)
                + convolve(&self.right_history, cursor, &self.right_source.right);
            (0.5 * out_left, 0.5 * out_right)
        };
        self.cursor = (cursor + 1) % self.mono_history.len();
        (out_left, out_right)
    }
}

fn embedded_dataset() -> Result<&'static HrtfDataset, String> {
    static DATASET: OnceLock<Result<HrtfDataset, String>> = OnceLock::new();
    match DATASET.get_or_init(|| HrtfDataset::parse(EMBEDDED_MHR)) {
        Ok(dataset) => Ok(dataset),
        Err(error) => Err(error.clone()),
    }
}

fn convolve(history: &[f32], cursor: usize, response: &EarResponse) -> f32 {
    let history_len = history.len();
    let integer_delay = response.delay_samples.floor() as usize;
    let fractional_delay = response.delay_samples - integer_delay as f32;
    response
        .taps
        .iter()
        .enumerate()
        .map(|(tap_index, coefficient)| {
            let delay = integer_delay.saturating_add(tap_index) % history_len;
            let current_index = (cursor + history_len - delay) % history_len;
            let previous_index = (current_index + history_len - 1) % history_len;
            let sample = history[current_index] * (1.0 - fractional_delay)
                + history[previous_index] * fractional_delay;
            sample * coefficient
        })
        .sum()
}

fn resample_taps(taps: &[f32], source_rate: u32, target_rate: u32) -> Vec<f32> {
    if source_rate == target_rate || taps.len() <= 1 {
        return taps.to_vec();
    }
    let ratio = target_rate as f64 / source_rate as f64;
    let output_len = (((taps.len() - 1) as f64 * ratio).round() as usize).saturating_add(1);
    let cutoff = ratio.min(1.0);
    let mut output = Vec::with_capacity(output_len);
    for output_index in 0..output_len {
        let source_position = output_index as f64 / ratio;
        let center = source_position.floor() as isize;
        let mut weighted_sum = 0.0_f64;
        let mut weight_sum = 0.0_f64;
        for source_index in (center - RESAMPLE_RADIUS + 1)..=(center + RESAMPLE_RADIUS) {
            if !(0..taps.len() as isize).contains(&source_index) {
                continue;
            }
            let distance = source_position - source_index as f64;
            let window_position = distance / RESAMPLE_RADIUS as f64;
            if window_position.abs() > 1.0 {
                continue;
            }
            let window = 0.5 * (1.0 + (std::f64::consts::PI * window_position).cos());
            let argument = distance * cutoff;
            let sinc = if argument.abs() < 1.0e-12 {
                1.0
            } else {
                (std::f64::consts::PI * argument).sin() / (std::f64::consts::PI * argument)
            };
            let weight = cutoff * sinc * window;
            weighted_sum += f64::from(taps[source_index as usize]) * weight;
            weight_sum += weight;
        }
        let interpolated = if weight_sum.abs() > 1.0e-12 {
            weighted_sum / weight_sum
        } else {
            0.0
        };
        // A discrete impulse response scales inversely with the new sample rate.
        output.push((interpolated / ratio) as f32);
    }
    output
}

struct MhrReader<'a> {
    bytes: &'a [u8],
    cursor: usize,
}

impl<'a> MhrReader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, cursor: 0 }
    }

    fn take(&mut self, count: usize) -> Result<&'a [u8], String> {
        let end = self
            .cursor
            .checked_add(count)
            .filter(|end| *end <= self.bytes.len())
            .ok_or_else(|| "انتهت بيانات MHR قبل اكتمالها".to_string())?;
        let bytes = &self.bytes[self.cursor..end];
        self.cursor = end;
        Ok(bytes)
    }

    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, String> {
        Ok(u16::from_le_bytes(
            self.take(2)?.try_into().expect("two-byte slice"),
        ))
    }

    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(
            self.take(4)?.try_into().expect("four-byte slice"),
        ))
    }

    fn i24(&mut self) -> Result<i32, String> {
        let bytes = self.take(3)?;
        let unsigned =
            i32::from(bytes[0]) | (i32::from(bytes[1]) << 8) | (i32::from(bytes[2]) << 16);
        Ok((unsigned << 8) >> 8)
    }

    fn is_empty(&self) -> bool {
        self.cursor == self.bytes.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_sadie_mhr_has_valid_measured_dataset_metadata() {
        let dataset = HrtfDataset::parse(EMBEDDED_MHR).expect("embedded MHR parses");
        assert_eq!(dataset.sample_rate, 48_000);
        assert_eq!(dataset.hrir_count(), 1_982);
        assert_eq!(dataset.fields.len(), 1);
        assert_eq!(dataset.fields[0].distance_mm, 1_200);
        assert_eq!(dataset.fields[0].elevations.len(), 13);
        assert_eq!(dataset.fields[0].elevations[0].degrees, -90.0);
        assert_eq!(dataset.fields[0].elevations[6].degrees, 0.0);
        assert_eq!(dataset.fields[0].elevations[12].degrees, 90.0);
        assert_eq!(dataset.fields[0].elevations[0].responses.len(), 1);
        assert_eq!(dataset.fields[0].elevations[1].responses.len(), 180);
        assert_eq!(dataset.fields[0].elevations[6].responses.len(), 180);
        assert_eq!(dataset.fields[0].elevations[12].responses.len(), 1);
    }

    #[test]
    fn packed_little_endian_int24_is_sign_extended_and_scaled() {
        let mut reader = MhrReader::new(&[0xff, 0xff, 0x7f, 0x00, 0x00, 0x80, 0xff, 0xff, 0xff]);
        assert_eq!(reader.i24().unwrap(), 8_388_607);
        assert_eq!(reader.i24().unwrap(), -8_388_608);
        let negative_one = reader.i24().unwrap();
        assert_eq!(negative_one, -1);
        assert_eq!(negative_one as f32 / 8_388_608.0, -1.0 / 8_388_608.0);
    }

    #[test]
    fn mono_measurements_mirror_the_second_ear_and_preserve_fractional_delay() {
        let dataset = HrtfDataset::parse(EMBEDDED_MHR).expect("embedded MHR parses");
        let row = &dataset.fields[0].elevations[6].responses;
        let right_of_listener = &row[15];
        let mirrored_left = &row[165];
        assert_eq!(
            right_of_listener.delay_samples[1],
            mirrored_left.delay_samples[0]
        );
        assert_eq!(right_of_listener.taps[10][1], mirrored_left.taps[10][0]);
        assert!(right_of_listener.delay_samples[0].fract() != 0.0);
    }

    #[test]
    fn hrtf_kernels_use_measured_left_right_responses_and_resample_for_output_rate() {
        let dataset = HrtfDataset::parse(EMBEDDED_MHR).expect("embedded MHR parses");
        let center = dataset.response(0.0, 0.0, 48_000).unwrap();
        let left = dataset.response(330.0, 0.0, 48_000).unwrap();
        let right = dataset.response(30.0, 0.0, 48_000).unwrap();
        assert_eq!(center.left.taps.len(), 64);
        assert_eq!(center.right.taps.len(), 64);
        assert_ne!(left.left.delay_samples, left.right.delay_samples);
        assert!(right.left.delay_samples > right.right.delay_samples);
        let at_44k = dataset.response(30.0, 0.0, 44_100).unwrap();
        assert_eq!(at_44k.left.taps.len(), 59);
        assert!(at_44k.left.taps.iter().all(|sample| sample.is_finite()));
        assert!(
            (at_44k.left.delay_samples - right.left.delay_samples * (44_100.0 / 48_000.0)).abs()
                < 1e-6
        );
        let sum_48k = right.left.taps.iter().sum::<f32>();
        let sum_44k = at_44k.left.taps.iter().sum::<f32>();
        assert!((sum_48k - sum_44k).abs() < sum_48k.abs() * 0.05 + 1e-3);
        assert!(HrtfRenderer::new(1).is_err());
    }

    #[test]
    fn malformed_or_truncated_mhr_is_rejected_without_panicking() {
        assert!(HrtfDataset::parse(&EMBEDDED_MHR[..14]).is_err());
        let mut invalid = EMBEDDED_MHR.to_vec();
        invalid[12] = 2;
        assert!(HrtfDataset::parse(&invalid).is_err());
    }

    #[test]
    fn binaural_renderer_has_no_per_sample_allocations_and_keeps_output_finite() {
        let mut renderer = HrtfRenderer::new(48_000).expect("real HRTF renderer initializes");
        for index in 0..4_096 {
            let input = if index % 127 == 0 { 1.0 } else { 0.0 };
            let (left, right) = renderer.process(input, input * 0.75, false);
            assert!(left.is_finite() && right.is_finite());
        }
        assert_eq!(renderer.mono_history.len(), renderer.left_history.len());
        assert_eq!(renderer.left_history.len(), renderer.right_history.len());
    }
}
