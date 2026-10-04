/**
 * ATmega328P memory map and core constants (see docs/01-how-it-works.md §2).
 * All addresses are *data-space* byte addresses unless noted otherwise.
 */

// --- Flash (program memory) ---
/** 16K 16-bit words = 32 KB of flash. */
export const FLASH_WORDS = 0x4000;

// --- Data space (one flat 8-bit address space: regs + I/O + SRAM) ---
/** Total modeled data bytes: 0x000..0x8FF. */
export const DATA_SIZE = 0x900;
/** First SRAM byte (variables + stack live here). */
export const SRAM_START = 0x100;
/** Last valid SRAM address; the stack pointer initializes here and grows down. */
export const RAMEND = 0x8ff;

// --- Register file (R0..R31) ---
export const REG_START = 0x00;
export const REG_COUNT = 32;

// --- I/O space ---
/**
 * IN/OUT/SBI/CBI encode I/O addresses (0x00..0x3F); add this to reach data space.
 * e.g. PORTB is I/O 0x05 -> data[0x05 + 0x20] = data[0x25].
 */
export const IO_BASE = 0x20;

// --- Status register & stack pointer (data-space addresses) ---
export const SREG_ADDR = 0x5f;
export const SPL_ADDR = 0x5d;
export const SPH_ADDR = 0x5e;

// --- GPIO ports (data-space addresses) ---
export const PINB = 0x23;
export const DDRB = 0x24;
export const PORTB = 0x25;
export const PINC = 0x26;
export const DDRC = 0x27;
export const PORTC = 0x28;
export const PIND = 0x29;
export const DDRD = 0x2a;
export const PORTD = 0x2b;

// --- Timer0 (data-space addresses) ---
export const TIFR0 = 0x35;
export const TCCR0A = 0x44;
export const TCCR0B = 0x45;
export const TCNT0 = 0x46;
export const OCR0A = 0x47;
export const OCR0B = 0x48;
export const TIMSK0 = 0x6e;

export const TOV0 = 0;
export const OCF0A = 1;
export const OCF0B = 2;
export const TOIE0 = 0;
export const OCIE0A = 1;
export const OCIE0B = 2;
export const WGM00 = 0;
export const WGM01 = 1;
export const COM0B0 = 4;
export const COM0B1 = 5;
export const COM0A0 = 6;
export const COM0A1 = 7;
export const CS00 = 0;
export const CS01 = 1;
export const CS02 = 2;
export const WGM02 = 3;

// --- Timer1 (16-bit, data-space addresses) ---
export const TIFR1 = 0x36;
export const TIMSK1 = 0x6f;
export const TCCR1A = 0x80;
export const TCCR1B = 0x81;
export const TCCR1C = 0x82;
export const TCNT1L = 0x84;
export const TCNT1H = 0x85;
export const ICR1L = 0x86;
export const ICR1H = 0x87;
export const OCR1AL = 0x88;
export const OCR1AH = 0x89;
export const OCR1BL = 0x8a;
export const OCR1BH = 0x8b;

export const TOV1 = 0;
export const OCF1A = 1;
export const OCF1B = 2;
export const ICF1 = 5;
export const TOIE1 = 0;
export const OCIE1A = 1;
export const OCIE1B = 2;
export const ICIE1 = 5;
export const ICES1 = 6; // in TCCR1B
export const ICNC1 = 7; // in TCCR1B
export const FOC1B = 6; // in TCCR1C
export const FOC1A = 7; // in TCCR1C
export const WGM10 = 0;
export const WGM11 = 1;
export const WGM12 = 3; // in TCCR1B
export const WGM13 = 4; // in TCCR1B
export const CS10 = 0;
export const CS11 = 1;
export const CS12 = 2;
export const COM1B0 = 4;
export const COM1B1 = 5;
export const COM1A0 = 6;
export const COM1A1 = 7;

// --- Timer2 (8-bit, data-space addresses) ---
export const TIFR2 = 0x37;
export const TIMSK2 = 0x70;
export const TCCR2A = 0xb0;
export const TCCR2B = 0xb1;
export const TCNT2 = 0xb2;
export const OCR2A = 0xb3;
export const OCR2B = 0xb4;
export const ASSR = 0xb6;

export const TOV2 = 0;
export const OCF2A = 1;
export const OCF2B = 2;
export const TOIE2 = 0;
export const OCIE2A = 1;
export const OCIE2B = 2;
// ASSR bits (Timer2 asynchronous mode)
export const EXCLK = 6;
export const AS2 = 5;
export const TCN2UB = 4;
export const OCR2AUB = 3;
export const OCR2BUB = 2;
export const TCR2AUB = 1;
export const TCR2BUB = 0;
// GTCCR (shared timer prescaler control)
export const GTCCR = 0x43;
export const TSM = 7;
export const PSRASY = 1;
export const PSRSYNC = 0;
export const WGM20 = 0;
export const WGM21 = 1;
export const WGM22 = 3; // in TCCR2B
export const CS20 = 0;
export const CS21 = 1;
export const CS22 = 2;
export const COM2B0 = 4;
export const COM2B1 = 5;
export const COM2A0 = 6;
export const COM2A1 = 7;

// --- Interrupt vectors (program word addresses) ---
export const RESET_VECTOR = 0x0000;
export const TIMER2_COMPA_VECTOR = 0x000e;
export const TIMER2_COMPB_VECTOR = 0x0010;
export const TIMER2_OVF_VECTOR = 0x0012;
export const TIMER1_CAPT_VECTOR = 0x0014;
export const TIMER1_COMPA_VECTOR = 0x0016;
export const TIMER1_COMPB_VECTOR = 0x0018;
export const TIMER1_OVF_VECTOR = 0x001a;
export const TIMER0_COMPA_VECTOR = 0x001c;
export const TIMER0_COMPB_VECTOR = 0x001e;
export const TIMER0_OVF_VECTOR = 0x0020;
export const SPI_STC_VECTOR = 0x0022;
export const USART_RX_VECTOR = 0x0024;
export const USART_UDRE_VECTOR = 0x0026;
export const USART_TX_VECTOR = 0x0028;
export const ADC_VECTOR = 0x002a;
export const EE_READY_VECTOR = 0x002c;
export const ANALOG_COMP_VECTOR = 0x002e;

// --- USART0 (data-space addresses) ---
export const UCSR0A = 0xc0;
export const UCSR0B = 0xc1;
export const UCSR0C = 0xc2;
export const UBRR0L = 0xc4;
export const UBRR0H = 0xc5;
export const UDR0 = 0xc6;

export const RXC0 = 7;
export const TXC0 = 6;
export const UDRE0 = 5;
export const FE0 = 4;
export const DOR0 = 3;
export const UPE0 = 2;
export const U2X0 = 1;
export const MPCM0 = 0;
export const RXCIE0 = 7;
export const TXCIE0 = 6;
export const UDRIE0 = 5;
export const RXEN0 = 4;
export const TXEN0 = 3;
export const UCSZ02 = 2;
export const RXB80 = 1;
export const TXB80 = 0;
export const UMSEL01 = 7;
export const UMSEL00 = 6;
export const UPM01 = 5;
export const UPM00 = 4;
export const USBS0 = 3;
export const UCSZ01 = 2;
export const UCSZ00 = 1;
export const UCPOL0 = 0;

// --- ADC (data-space addresses) ---
export const ADCL = 0x78;
export const ADCH = 0x79;
export const ADCSRA = 0x7a;
export const ADCSRB = 0x7b;
export const ADMUX = 0x7c;
export const DIDR0 = 0x7e;
export const DIDR1 = 0x7f;

export const ADTS0 = 0;
export const ADTS1 = 1;
export const ADTS2 = 2;
export const ACME = 6;
export const ADPS0 = 0;
export const ADPS1 = 1;
export const ADPS2 = 2;
export const ADIE = 3;
export const ADIF = 4;
export const ADATE = 5;
export const ADSC = 6;
export const ADEN = 7;
export const ADLAR = 5;
export const REFS0 = 6;
export const REFS1 = 7;

// --- External & pin-change interrupt vectors (program word addresses) ---
export const INT0_VECTOR = 0x0002;
export const INT1_VECTOR = 0x0004;
export const PCINT0_VECTOR = 0x0006;
export const PCINT1_VECTOR = 0x0008;
export const PCINT2_VECTOR = 0x000a;
export const WDT_VECTOR = 0x000c;
export const TWI_VECTOR = 0x0030;

// --- External interrupts (data-space addresses + flag/enable/sense bits) ---
export const EIFR = 0x3c;
export const EIMSK = 0x3d;
export const EICRA = 0x69;

export const INTF0 = 0;
export const INTF1 = 1;

export const INT0 = 0;
export const INT1 = 1;

export const ISC00 = 0;
export const ISC01 = 1;
export const ISC10 = 2;
export const ISC11 = 3;

// --- Pin-change interrupts (data-space addresses) ---
export const PCIFR = 0x3b;
export const PCICR = 0x68;
export const PCMSK0 = 0x6b;
export const PCMSK1 = 0x6c;
export const PCMSK2 = 0x6d;
export const PCIE0 = 0;
export const PCIE1 = 1;
export const PCIE2 = 2;
export const PCIF0 = 0;
export const PCIF1 = 1;
export const PCIF2 = 2;

// --- EEPROM (data-space addresses) ---
export const EECR = 0x3f;
export const EEDR = 0x40;
export const EEARL = 0x41;
export const EEARH = 0x42;
export const EERE = 0;
export const EEPE = 1;
export const EEMPE = 2;
export const EERIE = 3;
export const EEPROM_SIZE = 1024;

// --- SPI (data-space addresses) ---
export const SPCR = 0x4c;
export const SPSR = 0x4d;
export const SPDR = 0x4e;
export const SPIE = 7;
export const SPE = 6;
export const DORD = 5;
export const MSTR = 4;
export const SPR1 = 1;
export const SPR0 = 0;
export const SPIF = 7;
export const WCOL = 6;
export const SPI2X = 0;

// --- TWI / I2C (data-space addresses) ---
export const TWBR = 0xb8;
export const TWSR = 0xb9;
export const TWAR = 0xba;
export const TWDR = 0xbb;
export const TWCR = 0xbc;
export const TWAMR = 0xbd;
export const TWIE = 0;
export const TWEN = 2;
export const TWWC = 3;
export const TWSTO = 4;
export const TWSTA = 5;
export const TWEA = 6;
export const TWINT = 7;
export const TWPS0 = 0;
export const TWPS1 = 1;
export const TWGCE = 0;

// --- Sleep & watchdog (data-space addresses) ---
export const SMCR = 0x53;
export const SE = 0;
export const SM0 = 1;
export const SM1 = 2;
export const SM2 = 3;
export const MCUCR = 0x55;
export const SPMCSR = 0x57;
export const IVCE = 0;
export const IVSEL = 1;
export const PUD = 4;
export const BODSE = 5;
export const BODS = 6;
export const SELFPRGEN = 0;
export const PGERS = 1;
export const PGWRT = 2;
export const BLBSET = 3;
export const RWWSRE = 4;
export const SIGRD = 5;
export const RWWSB = 6;
export const SPMIE = 7;
export const MCUSR = 0x54;
export const PORF = 0;
export const EXTRF = 1;
export const BORF = 2;
export const WDRF = 3;
export const CLKPR = 0x61;
export const CLKPS0 = 0;
export const CLKPS1 = 1;
export const CLKPS2 = 2;
export const CLKPS3 = 3;
export const CLKPCE = 7;
export const PRR = 0x64;
export const PRADC = 0;
export const PRUSART0 = 1;
export const PRSPI = 2;
export const PRTIM1 = 3;
export const PRTIM0 = 5;
export const PRTIM2 = 6;
export const PRTWI = 7;
export const OSCCAL = 0x66;
export const WDTCSR = 0x60;
export const WDP0 = 0;
export const WDP1 = 1;
export const WDP2 = 2;
export const WDE = 3;
export const WDCE = 4;
export const WDP3 = 5;
export const WDIE = 6;
export const WDIF = 7;
export const SPM_READY_VECTOR = 0x0032;

// --- Analog comparator (data-space addresses) ---
export const ACSR = 0x50;
export const ACIS0 = 0;
export const ACIS1 = 1;
export const ACIC = 2;
export const ACIE = 3;
export const ACI = 4;
export const ACO = 5;
export const ACBG = 6;
export const ACD = 7;

// --- Timing ---
/** Default clock for Arduino Uno/Nano. */
export const DEFAULT_CLOCK_HZ = 16_000_000;
