import fs from 'fs';
const parts = [];
const P = (ref, type, value, block, note, extra = {}) => parts.push({ ref, type, value, block, note, ...extra });
// MCU
P('U1', 'esp32s3_mini1', 'ESP32-S3-MINI-1-N8', 'MCU', 'Brain: runs the toad animation, reads buttons/sensor/mic, talks BLE to the PC', { x: 30, y: 13 });
P('C1', 'c_0603', '10uF', 'MCU', 'Bulk decoupling for the module 3V3');
P('C2', 'c_0402', '100nF', 'MCU', 'High-frequency decoupling at the module 3V3 pin');
P('R1', 'r_0402', '10k', 'MCU', 'EN pull-up: keeps the chip running');
P('C3', 'c_0603', '1uF', 'MCU', 'EN delay cap: clean power-up reset (10 ms)');
P('SW_RST', 'btn_side', 'RESET', 'MCU', 'RESET button: pulls EN to ground');
P('SW_BOOT', 'btn_side', 'BOOT', 'MCU', 'BOOT button: hold at reset to enter flashing mode (GPIO0)');
// USB
P('J1', 'usbc_16', 'USB-C', 'USB-C Conn', 'USB-C: 5 V charging and USB data for flashing', { x: 23, y: 70, rot: 180 });
P('R2', 'r_0402', '5.1k', 'USB-C Conn', 'CC1 pull-down: tells the charger we are a 5 V device');
P('R3', 'r_0402', '5.1k', 'USB-C Conn', 'CC2 pull-down (cable can be plugged either way up)');
// Charger + battery
P('U2', 'found-c5381776', 'TP4054', 'Charger', 'Li-ion charger: charges the battery from USB, about 213 mA');
P('R4', 'r_0402', '4.7k', 'Charger', 'PROG resistor: sets charge current = 1000/4.7k = 213 mA');
P('R5', 'r_0402', '1k', 'Charger', 'Limits charge LED current to about 3 mA');
P('D1', 'led_0603', 'ORANGE', 'Charger', 'Charging indicator: lights while the battery charges');
P('C4', 'c_0603', '4.7uF', 'Charger', 'Charger input (VBUS) decoupling');
P('C5', 'c_0603', '4.7uF', 'Charger', 'Charger output (battery) decoupling');
P('J2', 'jst_sh_2', 'LiPo', 'Battery', 'Battery socket (pin 1 = +). Check the polarity of your battery!');
P('R6', 'r_0402', '470k', 'Battery', 'Battery sense divider, top');
P('R7', 'r_0402', '470k', 'Battery', 'Battery sense divider, bottom: halves battery voltage for the ADC');
P('C6', 'c_0402', '100nF', 'Battery', 'Filters the battery-sense voltage');
// LDO
P('U3', 'sot23_5', 'AP2112K-3.3', '3V3 Regulator', 'Low-dropout regulator: battery 3.0-4.2 V to steady 3.3 V', { elec: { kind: 'regulator', vout: 3.3, vin_max: 6, dropout: 0.25, roles: { 1: 'power_in', 3: 'power_in', 5: 'power_out', 2: 'ground' } } });
P('C7', 'c_0603', '10uF', '3V3 Regulator', 'LDO input capacitor');
P('C8', 'c_0603', '10uF', '3V3 Regulator', 'LDO output capacitor');
// Buttons
P('SW1', 'btn_side', 'POKE', 'Buttons', 'POKE: wake / interact (GPIO4, can wake from deep sleep)');
P('SW2', 'btn_side', 'TIME', 'Buttons', 'TIME: show the current time (GPIO5)');
P('SW3', 'btn_side', 'MIC', 'Buttons', 'MIC: push-to-talk, hold to record (GPIO6)');
// Motion
P('U4', 'lis2dh12', 'LIS2DH12', 'Motion Sensor', 'Accelerometer: shake, tap, pick-up, face-down; INT1 wakes the chip');
P('C9', 'c_0402', '100nF', 'Motion Sensor', 'VDD decoupling');
P('C10', 'c_0402', '100nF', 'Motion Sensor', 'VDD_IO decoupling');
P('R8', 'r_0402', '4.7k', 'Motion Sensor', 'I2C SDA pull-up');
P('R9', 'r_0402', '4.7k', 'Motion Sensor', 'I2C SCL pull-up');
// Mic
P('U5', 'mic_msm261', 'MSM261S4030H0R', 'Microphone', 'I2S digital MEMS microphone for push-to-talk');
P('C11', 'c_0402', '100nF', 'Microphone', 'Mic power decoupling');
// Crystal
P('Y1', 'xtal_3215', '32.768kHz', '32k Crystal', 'Watch crystal: accurate time while the chip sleeps');
P('C12', 'c_0402', '12pF', '32k Crystal', 'Crystal load capacitor');
P('C13', 'c_0402', '12pF', '32k Crystal', 'Crystal load capacitor');
// Display
P('J3', 'disp_hdr8', '1.69in ST7789', 'Display', '1.69in 240x280 display module header (SPI)', { x: 4, y: 24 });

const nets = {
  GND: ['J1.GND_A', 'J1.GND_B', 'J1.S1', 'J1.S2', 'J1.S3', 'J1.S4', 'J2.BATN', 'J2.S1', 'J2.S2', 'U2.2', 'R4.2', 'C4.2', 'C5.2', 'R7.2', 'C6.2', 'U3.2', 'C7.2', 'C8.2', 'C1.2', 'C2.2', 'C3.2',
    'SW_RST.B1', 'SW_RST.B2', 'SW_BOOT.B1', 'SW_BOOT.B2', 'SW1.B1', 'SW1.B2', 'SW2.B1', 'SW2.B2', 'SW3.B1', 'SW3.B2',
    'U4.GND6', 'U4.GND7', 'U4.GND8', 'U4.SDO', 'U4.RES', 'C9.2', 'C10.2', 'U5.GND', 'U5.LR', 'C11.2', 'C12.2', 'C13.2', 'J3.GND', 'R2.2', 'R3.2', 'D1.K_PLACEHOLDER'].filter(p => !p.includes('PLACEHOLDER')),
  VBUS: ['J1.VBUS_A', 'J1.VBUS_B', 'U2.4', 'C4.1', 'R5.1'],
  VBAT: ['J2.BATP', 'U2.3', 'C5.1', 'R6.1', 'U3.1', 'U3.3', 'C7.1'],
  '+3V3': ['U3.5', 'C8.1', 'U1.3V3', 'C1.1', 'C2.1', 'R1.1', 'R8.1', 'R9.1', 'U4.VDD', 'U4.VDDIO', 'U4.CS', 'C9.1', 'C10.1', 'U5.VDD', 'U5.CHIPEN', 'C11.1', 'J3.3V3'],
  CC1: ['J1.CC1', 'R2.1'], CC2: ['J1.CC2', 'R3.1'],
  USB_DP: ['J1.DP1', 'J1.DP2', 'U1.IO20'], USB_DM: ['J1.DM1', 'J1.DM2', 'U1.IO19'],
  PROG: ['U2.5', 'R4.1'], CHG_LED_A: ['R5.2', 'D1.A'], CHG_N: ['U2.1', 'D1.K'],
  VBAT_SENSE: ['R6.2', 'R7.1', 'C6.1', 'U1.IO1'],
  EN: ['U1.EN', 'R1.2', 'C3.1', 'SW_RST.A1', 'SW_RST.A2'],
  BOOT: ['U1.IO0', 'SW_BOOT.A1', 'SW_BOOT.A2'],
  POKE: ['U1.IO4', 'SW1.A1', 'SW1.A2'], TIME: ['U1.IO5', 'SW2.A1', 'SW2.A2'], MIC_BTN: ['U1.IO6', 'SW3.A1', 'SW3.A2'],
  IMU_INT1: ['U1.IO7', 'U4.INT1'], I2C_SDA: ['U1.IO8', 'U4.SDA', 'R8.2'], I2C_SCL: ['U1.IO9', 'U4.SCL', 'R9.2'],
  I2S_BCLK: ['U1.IO38', 'U5.SCK'], I2S_WS: ['U1.IO39', 'U5.WS'], I2S_DATA: ['U1.IO40', 'U5.SD'],
  XTAL_32K_P: ['U1.IO15', 'Y1.1', 'C12.1'], XTAL_32K_N: ['U1.IO16', 'Y1.2', 'C13.1'],
  LCD_CS: ['U1.IO10', 'J3.CS'], LCD_MOSI: ['U1.IO11', 'J3.MOSI'], LCD_SCK: ['U1.IO12', 'J3.SCK'],
  LCD_DC: ['U1.IO13', 'J3.DC'], LCD_RST: ['U1.IO14', 'J3.RST'], LCD_BL: ['U1.IO2', 'J3.BL'],
};
for (const n of ['GND1', 'GND2', 'GND42', 'GND43', ...Array.from({ length: 20 }, (_, i) => 'GND' + (46 + i))]) nets.GND.push('U1.' + n);
nets.GND.push('U1.GND1');
nets.GND = [...new Set(nets.GND)];
// LED cathode goes to the charger CHRG pin (open drain), so it is not on GND.
fs.writeFileSync(new URL('./design.json', import.meta.url), JSON.stringify({
  replace: true, board: { w: 46, h: 76 }, parts, nets,
  rules: { classes: [{ name: 'Power', width: 0.5, clearance: 0.2 }], assign: { VBUS: 'Power', VBAT: 'Power', '+3V3': 'Power' } },
}, null, 1));
