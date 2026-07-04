/*
 * Small simavr state dumper used by scripts/simavr-oracle.ts.
 *
 * It is built on demand against a local simavr install and is intentionally
 * boring C: load firmware, run until the requested cycle count, print JSON.
 */
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "simavr/avr_acomp.h"
#include "simavr/avr_adc.h"
#include "simavr/avr_ioport.h"
#include "simavr/avr_spi.h"
#include "simavr/avr_twi.h"
#include "simavr/avr_uart.h"
#include "simavr/sim_avr.h"
#include "simavr/sim_elf.h"
#include "simavr/sim_hex.h"
#include "simavr/sim_io.h"
#include "simavr/sim_irq.h"

typedef struct dump_range_t {
  const char *label;
  uint32_t addr;
  uint32_t length;
} dump_range_t;

typedef struct poke_t {
  uint32_t addr;
  uint8_t value;
} poke_t;

typedef struct until_result_t {
  int enabled;
  uint32_t addr;
  uint32_t length;
  uint8_t start;
  uint8_t end;
} until_result_t;

typedef struct byte_buffer_t {
  uint8_t *data;
  uint32_t length;
  uint32_t capacity;
} byte_buffer_t;

typedef struct start_buffer_t {
  uint8_t *addresses;
  uint8_t *reads;
  uint32_t length;
  uint32_t capacity;
} start_buffer_t;

typedef struct twi_slave_t {
  avr_irq_t *irq;
  uint8_t address;
  uint8_t selected;
  start_buffer_t starts;
  byte_buffer_t writes;
  byte_buffer_t reads;
  uint32_t stops;
} twi_slave_t;

typedef enum twi_master_phase_t {
  TWI_MASTER_IDLE = 0,
  TWI_MASTER_WRITE,
  TWI_MASTER_WAIT_READ,
  TWI_MASTER_READ,
  TWI_MASTER_WAIT_DONE,
  TWI_MASTER_DONE,
  TWI_MASTER_FAILED,
} twi_master_phase_t;

typedef struct twi_master_t {
  avr_t *avr;
  avr_irq_t *irq;
  uint8_t enabled;
  uint8_t started;
  uint8_t address;
  uint8_t selected;
  uint8_t write_bytes[3];
  uint8_t write_length;
  uint8_t write_index;
  uint8_t read_length;
  uint8_t read_index;
  uint64_t start_cycle;
  uint64_t next_action_cycle;
  twi_master_phase_t phase;
  start_buffer_t starts;
  byte_buffer_t writes;
  byte_buffer_t reads;
  uint32_t stops;
} twi_master_t;

typedef struct uart_rx_script_t {
  avr_t *avr;
  avr_irq_t *irq;
  uint8_t enabled;
  uint8_t phase;
} uart_rx_script_t;

typedef struct optiboot_script_t {
  avr_t *avr;
  avr_irq_t *irq;
  uint8_t enabled;
  uint8_t phase;
  uint8_t saw_portb_high;
  uint8_t saw_portb_low_after_high;
  uint8_t tx[160];
  uint32_t tx_length;
  uint32_t tx_index;
  uint32_t response_cursor;
  uint64_t next_action_cycle;
  uint64_t next_tx_cycle;
} optiboot_script_t;

typedef struct spi_master_t {
  avr_t *avr;
  avr_irq_t *irq;
  uint8_t enabled;
  uint8_t phase;
  uint8_t input_byte;
  uint64_t next_action_cycle;
  byte_buffer_t outputs;
} spi_master_t;

// Analog-comparator external driver: parks AIN0 below AIN1 (ACO low) at attach,
// then raises AIN0 above AIN1 at a fixed cycle to produce one rising edge. AIN
// values are millivolts, matching simavr's ACOMP AIN input IRQs.
#define ACOMP_AIN0_LOW_MV 500
#define ACOMP_AIN0_HIGH_MV 3000
#define ACOMP_AIN1_MV 1500

typedef struct comparator_t {
  uint8_t enabled;
  uint8_t injected;
  uint64_t inject_cycle;
} comparator_t;

static void attach_comparator(avr_t *avr, comparator_t *comparator, uint64_t inject_cycle) {
  memset(comparator, 0, sizeof(*comparator));
  comparator->enabled = 1;
  comparator->inject_cycle = inject_cycle;
  avr->vcc = 5000;
  avr->avcc = 5000;
  avr->aref = 5000;
  // Park the inputs so ACO starts low (AIN0 < AIN1).
  avr_raise_irq(avr_io_getirq(avr, AVR_IOCTL_ACOMP_GETIRQ, ACOMP_IRQ_AIN1), ACOMP_AIN1_MV);
  avr_raise_irq(avr_io_getirq(avr, AVR_IOCTL_ACOMP_GETIRQ, ACOMP_IRQ_AIN0), ACOMP_AIN0_LOW_MV);
}

static void comparator_tick(avr_t *avr, comparator_t *comparator) {
  if (!comparator->enabled || comparator->injected) return;
  if ((uint64_t)avr->cycle < comparator->inject_cycle) return;
  // Drive AIN0 above AIN1: one rising comparator-output edge.
  avr_raise_irq(avr_io_getirq(avr, AVR_IOCTL_ACOMP_GETIRQ, ACOMP_IRQ_AIN0), ACOMP_AIN0_HIGH_MV);
  comparator->injected = 1;
}

static void usage(const char *app) {
  fprintf(stderr,
          "Usage: %s --hex FILE [--mcu atmega328p] [--freq 16000000] "
          "[--cycles N] [--dump label:addr:length] [--poke addr:value] "
          "[--adc0-raw N] [--d2 high|low] "
          "[--until-result addr:length:start:end] [--flush-cycles N] "
          "[--uart-rx-script] [--optiboot-script] [--spi-master-script] [--twi-slave addr] [--twi-master-script addr] "
          "[--twi-master-start-cycle N]\n",
          app);
  exit(2);
}

static uint32_t parse_u32(const char *value, const char *flag) {
  char *end = NULL;
  unsigned long parsed = strtoul(value, &end, 0);
  if (!value[0] || (end && *end)) {
    fprintf(stderr, "%s expects an integer, got %s\n", flag, value);
    exit(2);
  }
  return (uint32_t)parsed;
}

static uint64_t parse_u64(const char *value, const char *flag) {
  char *end = NULL;
  unsigned long long parsed = strtoull(value, &end, 0);
  if (!value[0] || (end && *end)) {
    fprintf(stderr, "%s expects an integer, got %s\n", flag, value);
    exit(2);
  }
  return (uint64_t)parsed;
}

static dump_range_t parse_dump(const char *value) {
  char *copy = strdup(value);
  if (!copy) {
    fprintf(stderr, "out of memory\n");
    exit(1);
  }
  char *label = copy;
  char *addr = strchr(copy, ':');
  char *length = addr ? strchr(addr + 1, ':') : NULL;
  if (!addr || !length) {
    fprintf(stderr, "--dump expects label:addr:length, got %s\n", value);
    exit(2);
  }
  *addr = '\0';
  *length = '\0';
  dump_range_t range = {
      .label = label,
      .addr = parse_u32(addr + 1, "--dump addr"),
      .length = parse_u32(length + 1, "--dump length"),
  };
  return range;
}

static poke_t parse_poke(const char *value) {
  char *copy = strdup(value);
  if (!copy) {
    fprintf(stderr, "out of memory\n");
    exit(1);
  }
  char *addr = copy;
  char *byte = strchr(copy, ':');
  if (!byte) {
    fprintf(stderr, "--poke expects addr:value, got %s\n", value);
    exit(2);
  }
  *byte = '\0';
  uint32_t parsed = parse_u32(byte + 1, "--poke value");
  if (parsed > 0xff) {
    fprintf(stderr, "--poke value expects a byte, got %s\n", byte + 1);
    exit(2);
  }
  poke_t poke = {
      .addr = parse_u32(addr, "--poke addr"),
      .value = (uint8_t)parsed,
  };
  free(copy);
  return poke;
}

static until_result_t parse_until_result(const char *value) {
  char *copy = strdup(value);
  if (!copy) {
    fprintf(stderr, "out of memory\n");
    exit(1);
  }
  char *addr = copy;
  char *length = strchr(copy, ':');
  char *start = length ? strchr(length + 1, ':') : NULL;
  char *end = start ? strchr(start + 1, ':') : NULL;
  if (!length || !start || !end) {
    fprintf(stderr, "--until-result expects addr:length:start:end, got %s\n", value);
    exit(2);
  }
  *length = '\0';
  *start = '\0';
  *end = '\0';
  uint32_t parsed_start = parse_u32(start + 1, "--until-result start");
  uint32_t parsed_end = parse_u32(end + 1, "--until-result end");
  if (parsed_start > 0xff || parsed_end > 0xff) {
    fprintf(stderr, "--until-result start/end expect bytes\n");
    exit(2);
  }
  until_result_t result = {
      .enabled = 1,
      .addr = parse_u32(addr, "--until-result addr"),
      .length = parse_u32(length + 1, "--until-result length"),
      .start = (uint8_t)parsed_start,
      .end = (uint8_t)parsed_end,
  };
  free(copy);
  return result;
}

static int parse_bool_pin(const char *value, const char *flag) {
  if (!strcmp(value, "high") || !strcmp(value, "true") || !strcmp(value, "1")) return 1;
  if (!strcmp(value, "low") || !strcmp(value, "false") || !strcmp(value, "0")) return 0;
  fprintf(stderr, "%s expects high/low, true/false, or 1/0, got %s\n", flag, value);
  exit(2);
}

static const char *state_name(int state) {
  switch (state) {
    case cpu_Limbo:
      return "limbo";
    case cpu_Stopped:
      return "stopped";
    case cpu_Running:
      return "running";
    case cpu_Sleeping:
      return "sleeping";
    case cpu_Step:
      return "step";
    case cpu_StepDone:
      return "step-done";
    case cpu_Done:
      return "done";
    case cpu_Crashed:
      return "crashed";
    default:
      return "unknown";
  }
}

static void print_byte_array(const uint8_t *data, uint32_t length) {
  printf("[");
  for (uint32_t i = 0; i < length; i++) {
    if (i) printf(",");
    printf("%u", data[i]);
  }
  printf("]");
}

static void append_byte(byte_buffer_t *buffer, uint8_t value) {
  if (buffer->length == buffer->capacity) {
    uint32_t next_capacity = buffer->capacity ? buffer->capacity * 2 : 64;
    uint8_t *next = (uint8_t *)realloc(buffer->data, next_capacity);
    if (!next) {
      fprintf(stderr, "out of memory\n");
      exit(1);
    }
    buffer->data = next;
    buffer->capacity = next_capacity;
  }
  buffer->data[buffer->length++] = value;
}

static void append_start(start_buffer_t *buffer, uint8_t address, uint8_t read) {
  if (buffer->length == buffer->capacity) {
    uint32_t next_capacity = buffer->capacity ? buffer->capacity * 2 : 16;
    uint8_t *next_addresses = (uint8_t *)realloc(buffer->addresses, next_capacity);
    uint8_t *next_reads = (uint8_t *)realloc(buffer->reads, next_capacity);
    if (!next_addresses || !next_reads) {
      fprintf(stderr, "out of memory\n");
      exit(1);
    }
    buffer->addresses = next_addresses;
    buffer->reads = next_reads;
    buffer->capacity = next_capacity;
  }
  buffer->addresses[buffer->length] = address;
  buffer->reads[buffer->length] = read;
  buffer->length++;
}

static uint8_t next_twi_read(twi_slave_t *slave) {
  uint8_t last = slave->writes.length ? slave->writes.data[slave->writes.length - 1] : 0;
  uint8_t prev = slave->writes.length > 1 ? slave->writes.data[slave->writes.length - 2] : 0;
  return (uint8_t)(0xa5 ^ last ^ prev ^ ((slave->writes.length * 17) & 0xff));
}

static void uart_output_hook(struct avr_irq_t *irq, uint32_t value, void *param) {
  (void)irq;
  append_byte((byte_buffer_t *)param, (uint8_t)(value & 0xff));
}

static void attach_uart_rx_script(avr_t *avr, uart_rx_script_t *script) {
  memset(script, 0, sizeof(*script));
  script->avr = avr;
  script->enabled = 1;
  script->irq = avr_io_getirq(avr, AVR_IOCTL_UART_GETIRQ('0'), UART_IRQ_INPUT);
}

static void uart_rx_script_tick(uart_rx_script_t *script) {
  if (!script->enabled) return;
  if (script->phase == 0 && script->avr->data[0x327] == 0x71) {
    avr_raise_irq(script->irq, 0x31);
    script->phase = 1;
    return;
  }
  if (script->phase == 1 && script->avr->data[0x327] == 0x72) {
    avr_raise_irq(script->irq, 0x41);
    avr_raise_irq(script->irq, 0x42);
    avr_raise_irq(script->irq, 0x43);
    script->phase = 2;
  }
}

static void optiboot_send_bytes(optiboot_script_t *script, const uint8_t *bytes, uint32_t length) {
  if (length > sizeof(script->tx)) length = sizeof(script->tx);
  memcpy(script->tx, bytes, length);
  script->tx_length = length;
  script->tx_index = 0;
  script->next_tx_cycle = (uint64_t)script->avr->cycle;
}

static void optiboot_tx_tick(optiboot_script_t *script) {
  if (script->tx_index >= script->tx_length) return;
  if ((uint64_t)script->avr->cycle < script->next_tx_cycle) return;
  if ((script->avr->data[0xc0] & 0x80) != 0) return;
  avr_raise_irq(script->irq, script->tx[script->tx_index++]);
  script->next_tx_cycle = (uint64_t)script->avr->cycle + 2000;
}

static void optiboot_send_sync(optiboot_script_t *script) {
  static const uint8_t command[] = {0x30, 0x20};
  optiboot_send_bytes(script, command, sizeof(command));
}

static void optiboot_send_load_address(optiboot_script_t *script, uint16_t byte_address) {
  uint16_t word_address = byte_address >> 1;
  uint8_t command[] = {0x55, (uint8_t)(word_address & 0xff), (uint8_t)(word_address >> 8), 0x20};
  optiboot_send_bytes(script, command, sizeof(command));
}

static void optiboot_send_program_page(optiboot_script_t *script) {
  uint8_t command[5 + 128];
  static const uint8_t blink[] = {
      0x00, 0xe2, 0x04, 0xb9, 0x00, 0xe2, 0x05, 0xb9, 0x00, 0xe0, 0x05, 0xb9, 0xff, 0xcf,
  };
  command[0] = 0x64;
  command[1] = 0x00;
  command[2] = 0x80;
  command[3] = 0x46;
  memset(command + 4, 0xff, 128);
  memcpy(command + 4, blink, sizeof(blink));
  command[132] = 0x20;
  optiboot_send_bytes(script, command, sizeof(command));
}

static void optiboot_send_read_page(optiboot_script_t *script) {
  static const uint8_t command[] = {0x74, 0x00, 0x80, 0x46, 0x20};
  optiboot_send_bytes(script, command, sizeof(command));
}

static void optiboot_send_leave(optiboot_script_t *script) {
  static const uint8_t command[] = {0x51, 0x20};
  optiboot_send_bytes(script, command, sizeof(command));
}

static int optiboot_response_ok(const byte_buffer_t *serial, uint32_t cursor, uint32_t payload_length) {
  uint32_t length = payload_length + 2;
  if (serial->length < cursor + length) return 0;
  return serial->data[cursor] == 0x14 && serial->data[cursor + length - 1] == 0x10;
}

static void attach_optiboot_script(avr_t *avr, optiboot_script_t *script) {
  memset(script, 0, sizeof(*script));
  script->avr = avr;
  script->enabled = 1;
  script->irq = avr_io_getirq(avr, AVR_IOCTL_UART_GETIRQ('0'), UART_IRQ_INPUT);
  script->next_action_cycle = 100000;
  avr->pc = 0x7e00;
  avr->data[0x54] = 0x02; // MCUSR.EXTRF: Optiboot stays in programming mode after external reset.
}

static void optiboot_script_tick(optiboot_script_t *script, const byte_buffer_t *serial) {
  if (!script->enabled) return;
  if (script->avr->pc == 0x7e40 || script->avr->pc == 0x7e42) {
    script->avr->data[0x36] |= 0x01; // Native simavr does not advance Optiboot's Timer1 LED wait here.
  }
  optiboot_tx_tick(script);

  uint8_t portb = script->avr->data[0x25];
  if (portb == 0x20) script->saw_portb_high = 1;
  if (script->saw_portb_high && portb == 0x00) script->saw_portb_low_after_high = 1;

  if ((uint64_t)script->avr->cycle < script->next_action_cycle) return;
  if (script->tx_index < script->tx_length) return;

  switch (script->phase) {
    case 0:
      optiboot_send_sync(script);
      script->phase = 1;
      break;
    case 1:
      if (!optiboot_response_ok(serial, script->response_cursor, 0)) return;
      script->response_cursor += 2;
      optiboot_send_load_address(script, 0);
      script->phase = 2;
      break;
    case 2:
      if (!optiboot_response_ok(serial, script->response_cursor, 0)) return;
      script->response_cursor += 2;
      optiboot_send_program_page(script);
      script->phase = 3;
      break;
    case 3:
      if (!optiboot_response_ok(serial, script->response_cursor, 0)) return;
      script->response_cursor += 2;
      optiboot_send_load_address(script, 0);
      script->phase = 4;
      break;
    case 4:
      if (!optiboot_response_ok(serial, script->response_cursor, 0)) return;
      script->response_cursor += 2;
      optiboot_send_read_page(script);
      script->phase = 5;
      break;
    case 5:
      if (!optiboot_response_ok(serial, script->response_cursor, 128)) return;
      script->response_cursor += 130;
      optiboot_send_leave(script);
      script->phase = 6;
      break;
    case 6:
      if (!optiboot_response_ok(serial, script->response_cursor, 0)) return;
      script->response_cursor += 2;
      script->phase = 7;
      break;
    default:
      break;
  }
}

static void spi_master_output_hook(struct avr_irq_t *irq, uint32_t value, void *param) {
  (void)irq;
  append_byte(&((spi_master_t *)param)->outputs, (uint8_t)(value & 0xff));
}

static void attach_spi_master(avr_t *avr, spi_master_t *master) {
  memset(master, 0, sizeof(*master));
  master->avr = avr;
  master->enabled = 1;
  master->input_byte = 0x3c;
  master->irq = avr_io_getirq(avr, AVR_IOCTL_SPI_GETIRQ(0), SPI_IRQ_INPUT);
  avr_irq_register_notify(avr_io_getirq(avr, AVR_IOCTL_SPI_GETIRQ(0), SPI_IRQ_OUTPUT),
                          spi_master_output_hook, master);
}

static void spi_master_tick(avr_t *avr, spi_master_t *master) {
  if (!master->enabled || master->phase == 2) return;
  if (master->phase == 0 && avr->data[0x30e] == 0x51) {
    master->next_action_cycle = (uint64_t)avr->cycle + 32u;
    master->phase = 1;
    return;
  }
  if (master->phase == 1 && (uint64_t)avr->cycle >= master->next_action_cycle) {
    avr_raise_irq(master->irq, master->input_byte);
    master->phase = 2;
  }
}

static void twi_slave_hook(struct avr_irq_t *irq, uint32_t value, void *param) {
  (void)irq;
  twi_slave_t *slave = (twi_slave_t *)param;
  avr_twi_msg_irq_t message;
  message.u.v = value;

  if (message.u.twi.msg & TWI_COND_STOP) {
    if (slave->selected) slave->stops++;
    slave->selected = 0;
    return;
  }

  if (message.u.twi.msg & TWI_COND_START) {
    slave->selected = 0;
    if ((message.u.twi.addr >> 1) == slave->address) {
      slave->selected = message.u.twi.addr;
      append_start(&slave->starts, slave->address, (message.u.twi.addr & 1) ? 1 : 0);
      avr_raise_irq(slave->irq + TWI_IRQ_INPUT, avr_twi_irq_msg(TWI_COND_ACK, slave->selected, 1));
    }
    return;
  }

  if (!slave->selected) return;

  if (message.u.twi.msg & TWI_COND_WRITE) {
    append_byte(&slave->writes, message.u.twi.data);
    avr_raise_irq(slave->irq + TWI_IRQ_INPUT, avr_twi_irq_msg(TWI_COND_ACK, slave->selected, 1));
  }

  if (message.u.twi.msg & TWI_COND_READ) {
    uint8_t value_to_send = next_twi_read(slave);
    append_byte(&slave->reads, value_to_send);
    avr_raise_irq(slave->irq + TWI_IRQ_INPUT, avr_twi_irq_msg(TWI_COND_READ, slave->selected, value_to_send));
  }
}

static const char *twi_irq_names[TWI_IRQ_COUNT] = {
    [TWI_IRQ_INPUT] = "8>oracle-twi.out",
    [TWI_IRQ_OUTPUT] = "32<oracle-twi.in",
    [TWI_IRQ_STATUS] = "oracle-twi.status",
};

static void attach_twi_slave(avr_t *avr, twi_slave_t *slave, uint8_t address) {
  memset(slave, 0, sizeof(*slave));
  slave->address = address;
  slave->irq = avr_alloc_irq(&avr->irq_pool, 0, TWI_IRQ_COUNT, twi_irq_names);
  avr_irq_register_notify(slave->irq + TWI_IRQ_OUTPUT, twi_slave_hook, slave);
  avr_connect_irq(slave->irq + TWI_IRQ_INPUT, avr_io_getirq(avr, AVR_IOCTL_TWI_GETIRQ(0), TWI_IRQ_INPUT));
  avr_connect_irq(avr_io_getirq(avr, AVR_IOCTL_TWI_GETIRQ(0), TWI_IRQ_OUTPUT), slave->irq + TWI_IRQ_OUTPUT);
}

static void twi_master_start_write(twi_master_t *master) {
  master->started = 1;
  master->selected = master->address;
  master->phase = TWI_MASTER_WRITE;
  append_start(&master->starts, master->address, 0);
  avr_raise_irq(master->irq + TWI_IRQ_INPUT,
                avr_twi_irq_msg(TWI_COND_START | TWI_COND_ADDR | TWI_COND_WRITE,
                                master->selected, 1));
}

static void twi_master_start_read(twi_master_t *master) {
  master->selected = master->address;
  master->phase = TWI_MASTER_READ;
  append_start(&master->starts, master->address, 1);
  avr_raise_irq(master->irq + TWI_IRQ_INPUT,
                avr_twi_irq_msg(TWI_COND_START | TWI_COND_ADDR | TWI_COND_READ,
                                master->selected, 1));
}

static void twi_master_stop(twi_master_t *master) {
  master->stops++;
  avr_raise_irq(master->irq + TWI_IRQ_INPUT, avr_twi_irq_msg(TWI_COND_STOP, master->selected, 0));
  master->selected = 0;
}

static void twi_master_send_next_write(twi_master_t *master) {
  if (master->write_index < master->write_length) {
    uint8_t value = master->write_bytes[master->write_index++];
    append_byte(&master->writes, value);
    avr_raise_irq(master->irq + TWI_IRQ_INPUT, avr_twi_irq_msg(TWI_COND_WRITE, master->selected, value));
    return;
  }

  twi_master_stop(master);
  master->phase = TWI_MASTER_WAIT_READ;
  master->next_action_cycle = (uint64_t)master->avr->cycle + 50000u;
}

static void twi_master_receive_read_byte(twi_master_t *master, uint8_t value) {
  append_byte(&master->reads, value);
  master->read_index++;
  avr_raise_irq(master->irq + TWI_IRQ_INPUT,
                avr_twi_irq_msg(TWI_COND_READ |
                                    (master->read_index < master->read_length ? TWI_COND_ACK : 0),
                                master->selected, 1));
  if (master->read_index >= master->read_length) {
    master->phase = TWI_MASTER_WAIT_DONE;
    master->next_action_cycle = (uint64_t)master->avr->cycle + 50000u;
  }
}

static void twi_master_hook(struct avr_irq_t *irq, uint32_t value, void *param) {
  (void)irq;
  twi_master_t *master = (twi_master_t *)param;
  avr_twi_msg_irq_t message;
  message.u.v = value;

  if (!master->enabled || !master->started || master->phase == TWI_MASTER_DONE ||
      master->phase == TWI_MASTER_FAILED) {
    return;
  }

  if (master->phase == TWI_MASTER_WRITE) {
    if ((message.u.twi.msg & (TWI_COND_ADDR | TWI_COND_ACK)) == (TWI_COND_ADDR | TWI_COND_ACK)) {
      twi_master_send_next_write(master);
    }
    return;
  }

  if (master->phase == TWI_MASTER_READ) {
    if ((message.u.twi.msg & TWI_COND_READ) && (message.u.twi.msg & TWI_COND_ACK) &&
        master->read_index < master->read_length) {
      twi_master_receive_read_byte(master, message.u.twi.data);
      return;
    }
  }
}

static const char *twi_master_irq_names[TWI_IRQ_COUNT] = {
    [TWI_IRQ_INPUT] = "8>oracle-master.out",
    [TWI_IRQ_OUTPUT] = "32<oracle-master.in",
    [TWI_IRQ_STATUS] = "oracle-master.status",
};

static void attach_twi_master(avr_t *avr, twi_master_t *master, uint8_t address, uint64_t start_cycle) {
  memset(master, 0, sizeof(*master));
  master->avr = avr;
  master->enabled = 1;
  master->address = address;
  master->write_bytes[0] = 0x11;
  master->write_bytes[1] = 0x22;
  master->write_bytes[2] = 0x33;
  master->write_length = 3;
  master->read_length = 1;
  master->start_cycle = start_cycle;
  master->phase = TWI_MASTER_IDLE;
  master->irq = avr_alloc_irq(&avr->irq_pool, 0, TWI_IRQ_COUNT, twi_master_irq_names);
  avr_irq_register_notify(master->irq + TWI_IRQ_OUTPUT, twi_master_hook, master);
  avr_connect_irq(master->irq + TWI_IRQ_INPUT, avr_io_getirq(avr, AVR_IOCTL_TWI_GETIRQ(0), TWI_IRQ_INPUT));
  avr_connect_irq(avr_io_getirq(avr, AVR_IOCTL_TWI_GETIRQ(0), TWI_IRQ_OUTPUT), master->irq + TWI_IRQ_OUTPUT);
}

static int arduino_wire_slave_ready(avr_t *avr) {
  uint32_t ram_size = (uint32_t)avr->ramend + 1;
  if (0x308u > ram_size) return 0;
  return avr->data[0x300] == 0xa7 && avr->data[0x307] == 0x5c;
}

static int arduino_wire_slave_received_write(avr_t *avr) {
  uint32_t ram_size = (uint32_t)avr->ramend + 1;
  if (0x309u > ram_size) return 0;
  return avr->data[0x301] == 1 && avr->data[0x303] == 3 && avr->data[0x304] == (0x11 ^ 0x22 ^ 0x33) &&
         avr->data[0x305] == 0x33 && avr->data[0x308] == 3;
}

static int arduino_wire_slave_transmitted_response(avr_t *avr) {
  uint32_t ram_size = (uint32_t)avr->ramend + 1;
  if (0x307u > ram_size) return 0;
  return avr->data[0x302] == 1 && avr->data[0x306] == (uint8_t)(0x90 ^ (0x11 ^ 0x22 ^ 0x33) ^ 1);
}

static void twi_master_tick(avr_t *avr, twi_master_t *master) {
  if (!master->enabled || master->phase == TWI_MASTER_DONE || master->phase == TWI_MASTER_FAILED) return;

  if (!master->started) {
    if ((uint64_t)avr->cycle >= master->start_cycle && arduino_wire_slave_ready(avr)) {
      twi_master_start_write(master);
    }
    return;
  }

  if (master->phase == TWI_MASTER_WAIT_READ &&
      (uint64_t)avr->cycle >= master->next_action_cycle &&
      arduino_wire_slave_received_write(avr)) {
    twi_master_start_read(master);
    return;
  }

  if (master->phase == TWI_MASTER_READ && master->read_index < master->read_length &&
      arduino_wire_slave_transmitted_response(avr)) {
    twi_master_receive_read_byte(master, avr->data[0x306]);
    return;
  }

  if (master->phase == TWI_MASTER_WAIT_DONE && (uint64_t)avr->cycle >= master->next_action_cycle) {
    master->phase = TWI_MASTER_DONE;
  }
}

static int result_complete(avr_t *avr, const until_result_t *until) {
  if (!until->enabled || until->length == 0) return 0;
  uint32_t ram_size = (uint32_t)avr->ramend + 1;
  if (until->addr >= ram_size || until->addr + until->length > ram_size) return 0;
  return avr->data[until->addr] == until->start && avr->data[until->addr + until->length - 1] == until->end;
}

int main(int argc, char **argv) {
  const char *hex = NULL;
  const char *mcu = "atmega328p";
  uint32_t frequency = 16000000;
  uint64_t target_cycles = 1000;
  uint64_t flush_cycles = 0;
  dump_range_t dumps[32];
  int dump_count = 0;
  poke_t pokes[32];
  int poke_count = 0;
  int adc0_raw = -1;
  int d2 = -1;
  int twi_slave_enabled = 0;
  uint8_t twi_slave_address = 0;
  int uart_rx_script_enabled = 0;
  int optiboot_script_enabled = 0;
  int spi_master_enabled = 0;
  int comparator_enabled = 0;
  uint64_t comparator_inject_cycle = 50000u;
  int twi_master_enabled = 0;
  uint8_t twi_master_address = 0;
  uint64_t twi_master_start_cycle = 100000u;
  until_result_t until_result;
  memset(&until_result, 0, sizeof(until_result));

  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--hex") && i + 1 < argc) {
      hex = argv[++i];
    } else if (!strcmp(argv[i], "--mcu") && i + 1 < argc) {
      mcu = argv[++i];
    } else if (!strcmp(argv[i], "--freq") && i + 1 < argc) {
      frequency = parse_u32(argv[++i], "--freq");
    } else if (!strcmp(argv[i], "--cycles") && i + 1 < argc) {
      target_cycles = parse_u64(argv[++i], "--cycles");
    } else if (!strcmp(argv[i], "--dump") && i + 1 < argc) {
      if (dump_count >= (int)(sizeof(dumps) / sizeof(dumps[0]))) {
        fprintf(stderr, "too many --dump ranges\n");
        return 2;
      }
      dumps[dump_count++] = parse_dump(argv[++i]);
    } else if (!strcmp(argv[i], "--poke") && i + 1 < argc) {
      if (poke_count >= (int)(sizeof(pokes) / sizeof(pokes[0]))) {
        fprintf(stderr, "too many --poke values\n");
        return 2;
      }
      pokes[poke_count++] = parse_poke(argv[++i]);
    } else if (!strcmp(argv[i], "--adc0-raw") && i + 1 < argc) {
      uint32_t parsed = parse_u32(argv[++i], "--adc0-raw");
      if (parsed > 1023) {
        fprintf(stderr, "--adc0-raw expects 0..1023\n");
        return 2;
      }
      adc0_raw = (int)parsed;
    } else if (!strcmp(argv[i], "--d2") && i + 1 < argc) {
      d2 = parse_bool_pin(argv[++i], "--d2");
    } else if (!strcmp(argv[i], "--until-result") && i + 1 < argc) {
      until_result = parse_until_result(argv[++i]);
    } else if (!strcmp(argv[i], "--flush-cycles") && i + 1 < argc) {
      flush_cycles = parse_u64(argv[++i], "--flush-cycles");
    } else if (!strcmp(argv[i], "--uart-rx-script")) {
      uart_rx_script_enabled = 1;
    } else if (!strcmp(argv[i], "--optiboot-script")) {
      optiboot_script_enabled = 1;
    } else if (!strcmp(argv[i], "--spi-master-script")) {
      spi_master_enabled = 1;
    } else if (!strcmp(argv[i], "--acomp-script")) {
      comparator_enabled = 1;
    } else if (!strcmp(argv[i], "--acomp-inject-cycle") && i + 1 < argc) {
      comparator_inject_cycle = parse_u64(argv[++i], "--acomp-inject-cycle");
    } else if (!strcmp(argv[i], "--twi-slave") && i + 1 < argc) {
      uint32_t parsed = parse_u32(argv[++i], "--twi-slave");
      if (parsed > 0x7f) {
        fprintf(stderr, "--twi-slave expects a 7-bit address\n");
        return 2;
      }
      twi_slave_enabled = 1;
      twi_slave_address = (uint8_t)parsed;
    } else if (!strcmp(argv[i], "--twi-master-script") && i + 1 < argc) {
      uint32_t parsed = parse_u32(argv[++i], "--twi-master-script");
      if (parsed > 0x7f) {
        fprintf(stderr, "--twi-master-script expects a 7-bit address\n");
        return 2;
      }
      twi_master_enabled = 1;
      twi_master_address = (uint8_t)parsed;
    } else if (!strcmp(argv[i], "--twi-master-start-cycle") && i + 1 < argc) {
      twi_master_start_cycle = parse_u64(argv[++i], "--twi-master-start-cycle");
    } else {
      usage(argv[0]);
    }
  }
  if (!hex) usage(argv[0]);

  elf_firmware_t firmware;
  memset(&firmware, 0, sizeof(firmware));
  snprintf(firmware.mmcu, sizeof(firmware.mmcu), "%s", mcu);
  firmware.frequency = frequency;
  sim_setup_firmware(hex, AVR_SEGMENT_OFFSET_FLASH, &firmware, argv[0]);
  snprintf(firmware.mmcu, sizeof(firmware.mmcu), "%s", mcu);
  firmware.frequency = frequency;

  avr_t *avr = avr_make_mcu_by_name(firmware.mmcu);
  if (!avr) {
    fprintf(stderr, "unknown AVR core %s\n", firmware.mmcu);
    return 1;
  }
  avr_init(avr);
  avr->log = LOG_NONE;
  avr_load_firmware(avr, &firmware);

  for (int i = 0; i < poke_count; i++) {
    uint32_t ram_size = (uint32_t)avr->ramend + 1;
    if (pokes[i].addr < ram_size) avr->data[pokes[i].addr] = pokes[i].value;
  }

  if (adc0_raw >= 0) {
    avr->vcc = 5000;
    avr->avcc = 5000;
    avr->aref = 5000;
    uint32_t millivolts = ((uint32_t)adc0_raw * 5000u + 1022u) / 1023u;
    avr_raise_irq(avr_io_getirq(avr, AVR_IOCTL_ADC_GETIRQ, ADC_IRQ_ADC0), millivolts);
  }

  if (d2 >= 0) {
    avr_ioport_external_t external = {
        .name = 'D',
        .mask = (1 << 2),
        .value = d2 ? (1 << 2) : 0,
    };
    avr_ioctl(avr, AVR_IOCTL_IOPORT_SET_EXTERNAL('D'), &external);
    avr_raise_irq(avr_io_getirq(avr, AVR_IOCTL_IOPORT_GETIRQ('D'), IOPORT_IRQ_PIN2), d2 ? 1 : 0);
  }

  byte_buffer_t serial;
  memset(&serial, 0, sizeof(serial));
  avr_irq_register_notify(avr_io_getirq(avr, AVR_IOCTL_UART_GETIRQ('0'), UART_IRQ_OUTPUT), uart_output_hook, &serial);

  uart_rx_script_t uart_rx_script;
  memset(&uart_rx_script, 0, sizeof(uart_rx_script));
  if (uart_rx_script_enabled) attach_uart_rx_script(avr, &uart_rx_script);

  optiboot_script_t optiboot_script;
  memset(&optiboot_script, 0, sizeof(optiboot_script));
  if (optiboot_script_enabled) attach_optiboot_script(avr, &optiboot_script);

  spi_master_t spi_master;
  memset(&spi_master, 0, sizeof(spi_master));
  if (spi_master_enabled) attach_spi_master(avr, &spi_master);

  comparator_t comparator;
  memset(&comparator, 0, sizeof(comparator));
  if (comparator_enabled) attach_comparator(avr, &comparator, comparator_inject_cycle);

  twi_slave_t twi_slave;
  memset(&twi_slave, 0, sizeof(twi_slave));
  if (twi_slave_enabled) attach_twi_slave(avr, &twi_slave, twi_slave_address);

  twi_master_t twi_master;
  memset(&twi_master, 0, sizeof(twi_master));
  if (twi_master_enabled) attach_twi_master(avr, &twi_master, twi_master_address, twi_master_start_cycle);

  int state = avr->state;
  while ((uint64_t)avr->cycle < target_cycles) {
    if (uart_rx_script_enabled) uart_rx_script_tick(&uart_rx_script);
    if (optiboot_script_enabled) optiboot_script_tick(&optiboot_script, &serial);
    if (spi_master_enabled) spi_master_tick(avr, &spi_master);
    if (comparator_enabled) comparator_tick(avr, &comparator);
    if (twi_master_enabled) twi_master_tick(avr, &twi_master);
    state = avr_run(avr);
    if (state == cpu_Done || state == cpu_Crashed) break;
    if (until_result.enabled && result_complete(avr, &until_result)) break;
    if (!until_result.enabled && twi_master_enabled && twi_master.phase == TWI_MASTER_DONE) break;
    if (!until_result.enabled && optiboot_script_enabled && optiboot_script.phase >= 7 &&
        optiboot_script.saw_portb_low_after_high) break;
  }
  int completed = until_result.enabled
                      ? result_complete(avr, &until_result)
                      : (optiboot_script_enabled
                             ? (optiboot_script.phase >= 7 && optiboot_script.saw_portb_low_after_high)
                             : (twi_master_enabled ? twi_master.phase == TWI_MASTER_DONE : 0));
  if (completed && flush_cycles > 0) {
    uint64_t flush_target = (uint64_t)avr->cycle + flush_cycles;
    while ((uint64_t)avr->cycle < flush_target) {
      if (uart_rx_script_enabled) uart_rx_script_tick(&uart_rx_script);
      if (optiboot_script_enabled) optiboot_script_tick(&optiboot_script, &serial);
      if (spi_master_enabled) spi_master_tick(avr, &spi_master);
      if (twi_master_enabled) twi_master_tick(avr, &twi_master);
      state = avr_run(avr);
      if (state == cpu_Done || state == cpu_Crashed) break;
    }
  }

  uint16_t sp = (uint16_t)(avr->data[R_SPL] | (avr->data[R_SPH] << 8));
  printf("{");
  printf("\"mcu\":\"%s\",", firmware.mmcu);
  printf("\"frequency\":%" PRIu32 ",", firmware.frequency);
  printf("\"targetCycles\":%" PRIu64 ",", target_cycles);
  printf("\"cycles\":%" PRIu64 ",", (uint64_t)avr->cycle);
  printf("\"completed\":%s,", completed ? "true" : "false");
  printf("\"state\":\"%s\",", state_name(state));
  printf("\"pcBytes\":%" PRIu32 ",", (uint32_t)avr->pc);
  printf("\"pcWords\":%" PRIu32 ",", (uint32_t)(avr->pc >> 1));
  printf("\"sp\":%u,", sp);
  printf("\"sreg\":%u,", avr->data[R_SREG]);
  printf("\"registers\":");
  print_byte_array(avr->data, 32);
  printf(",\"dumps\":{");
  for (int i = 0; i < dump_count; i++) {
    if (i) printf(",");
    uint32_t addr = dumps[i].addr;
    uint32_t length = dumps[i].length;
    uint32_t ram_size = (uint32_t)avr->ramend + 1;
    if (addr > ram_size) length = 0;
    if (addr + length > ram_size) length = ram_size - addr;
    printf("\"%s\":", dumps[i].label);
    print_byte_array(avr->data + addr, length);
  }
  printf("},\"serial\":");
  print_byte_array(serial.data, serial.length);
  printf(",\"flash\":");
  print_byte_array(avr->flash, 128);
  printf(",\"optiboot\":{\"phase\":%u,\"sawPortBHigh\":%s,\"sawPortBLowAfterHigh\":%s}",
         optiboot_script.phase,
         optiboot_script.saw_portb_high ? "true" : "false",
         optiboot_script.saw_portb_low_after_high ? "true" : "false");
  printf(",\"twi\":{\"starts\":[");
  for (uint32_t i = 0; i < twi_slave.starts.length; i++) {
    if (i) printf(",");
    printf("\"%c@%02x\"", twi_slave.starts.reads[i] ? 'R' : 'W', twi_slave.starts.addresses[i]);
  }
  printf("],\"writes\":");
  print_byte_array(twi_slave.writes.data, twi_slave.writes.length);
  printf(",\"reads\":");
  print_byte_array(twi_slave.reads.data, twi_slave.reads.length);
  printf(",\"stops\":%" PRIu32 "}", twi_slave.stops);
  printf(",\"twiMaster\":{\"starts\":[");
  for (uint32_t i = 0; i < twi_master.starts.length; i++) {
    if (i) printf(",");
    printf("\"%c@%02x\"", twi_master.starts.reads[i] ? 'R' : 'W', twi_master.starts.addresses[i]);
  }
  printf("],\"writes\":");
  print_byte_array(twi_master.writes.data, twi_master.writes.length);
  printf(",\"reads\":");
  print_byte_array(twi_master.reads.data, twi_master.reads.length);
  printf(",\"stops\":%" PRIu32 ",\"completed\":%s,\"failed\":%s}", twi_master.stops,
         twi_master.phase == TWI_MASTER_DONE ? "true" : "false",
         twi_master.phase == TWI_MASTER_FAILED ? "true" : "false");
  printf(",\"spiMaster\":{\"writes\":[%u],\"outputs\":", spi_master_enabled ? spi_master.input_byte : 0);
  print_byte_array(spi_master.outputs.data, spi_master.outputs.length);
  printf(",\"completed\":%s}}", spi_master.phase == 2 ? "true" : "false");
  printf("\n");

  avr_terminate(avr);
  free(serial.data);
  free(spi_master.outputs.data);
  free(twi_slave.starts.addresses);
  free(twi_slave.starts.reads);
  free(twi_slave.writes.data);
  free(twi_slave.reads.data);
  free(twi_master.starts.addresses);
  free(twi_master.starts.reads);
  free(twi_master.writes.data);
  free(twi_master.reads.data);
  return state == cpu_Crashed ? 1 : 0;
}
